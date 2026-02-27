import { ToolUseResult } from './tools';
import { ProjectService } from '../../../services/project.service';
import { ConnectionGraphService, PinSummary, PinmapCatalog, ComponentInstanceInput, ComponentConfig, PinmapProtocol } from '../../../services/connection-graph.service';
import { injectTodoReminder } from './todoWriteTool';

/**
 * 解析后的组件实例信息（内部使用）
 */
interface ParsedComponentInstance {
  /** pinmapId 完整标识符 */
  pinmapId: string;
  /** 用户定义的别名（用于 refId） */
  alias: string;
  /** 显示名称 */
  label?: string;
  /** 同一 pinmapId 的第几个实例 (0-based) */
  instance: number;
}

/**
 * generate_schematic 工具
 *
 * 读取开发板和外设的引脚信息，构建 prompt 返回给 Agent，
 * 让 Agent 根据引脚信息输出标准格式的连线 JSON。
 *
 * 支持两种方式指定组件：
 * 1. pinmapIds: 完整标识符列表 (推荐)，支持多实例（对象格式带别名）
 * 2. components: 简称列表 (旧版兼容)，如 ["dht20"]
 */
export async function generateConnectionGraphTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapIds?: ComponentInstanceInput[]; components?: string[]; requirements?: string }
): Promise<ToolUseResult> {
  try {
    const boardPackagePath = await projectService.getBoardPackagePath();
    if (!boardPackagePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目或未安装开发板包，请先创建/打开一个项目。',
      };
    }

    // 读取开发板 pinmap（支持旧版 pinmap.json 和新版 catalog + pinmaps/ 两种结构）
    const boardConfig = connectionGraphService.getBoardConfig(boardPackagePath);
    if (!boardConfig) {
      return {
        is_error: true,
        content: '开发板引脚配置不存在，无法生成连线图。请先使用 generate_pinmap + save_pinmap 为该开发板生成 pinmap 配置。',
      };
    }

    // 直接使用 currentProjectPath 构建 packagesBasePath（参考 getContextTool.ts）
    const currentProjectPath = projectService.currentProjectPath;
    // 使用字符串模板确保类型正确
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;

    // 收集引脚摘要
    const pinSummaries: PinSummary[] = [];
    // 解析后的组件实例列表
    const componentInstances: ParsedComponentInstance[] = [];
    // 软件组件列表（WiFi/MQTT等，无引脚）
    const softwareComponents: Array<{
      pinmapId: string;
      alias: string;
      label?: string;
      libraryType: string;
      displayName: string;
      configTemplate?: any[];
    }> = [];
    // 加载失败的 pinmapIds（pinmap 文件不存在或无法读取）
    const failedPinmapIds: Array<{ pinmapId: string; reason: string }> = [];

    // 1. 添加开发板引脚摘要
    const boardSummary = connectionGraphService.getBoardPinSummary(boardPackagePath);
    if (boardSummary) {
      pinSummaries.push(boardSummary);
    }

    // 2. 解析 pinmapIds（支持字符串和对象两种格式）
    const loadedPinmapIds: string[] = [];
    let rawPinmapIds: ComponentInstanceInput[] = [];
    
    if (input.pinmapIds) {
      if (Array.isArray(input.pinmapIds)) {
        rawPinmapIds = input.pinmapIds;
      } else if (typeof input.pinmapIds === 'string') {
        // 尝试解析 JSON 字符串
        try {
          const parsed = JSON.parse(input.pinmapIds);
          rawPinmapIds = Array.isArray(parsed) ? parsed : [input.pinmapIds];
        } catch {
          rawPinmapIds = [input.pinmapIds];
        }
      }
    }
    
    // 统计每个 pinmapId 出现的次数（用于生成实例编号）
    const pinmapIdCountMap = new Map<string, number>();
    
    if (rawPinmapIds.length > 0 && packagesBasePath) {
      for (const item of rawPinmapIds) {
        // 解析输入项（字符串或对象）
        let pinmapId: string;
        let alias: string | undefined;
        let label: string | undefined;
        
        if (typeof item === 'string') {
          pinmapId = item;
        } else if (typeof item === 'object' && item !== null) {
          pinmapId = item.id;
          alias = item.alias;
          label = item.label;
        } else {
          continue; // 跳过无效项
        }
        
        // 计算实例编号
        const instanceIndex = pinmapIdCountMap.get(pinmapId) || 0;
        pinmapIdCountMap.set(pinmapId, instanceIndex + 1);
        
        // 生成默认别名（如果未指定）
        if (!alias) {
          const ref = connectionGraphService.parsePinmapId(pinmapId);
          alias = instanceIndex === 0 
            ? ref.modelId 
            : `${ref.modelId}_${instanceIndex + 1}`;
        }
        
        // 检测是否为软件组件（WiFi/MQTT等无引脚组件）
        const softwareCheck = connectionGraphService.checkSoftwareComponent(pinmapId, packagesBasePath);
        if (softwareCheck.isSoftware && softwareCheck.catalog) {
          const catalog = softwareCheck.catalog;
          softwareComponents.push({
            pinmapId,
            alias,
            label,
            libraryType: catalog.softwareMeta?.libraryType || 'other',
            displayName: catalog.displayName,
            configTemplate: catalog.softwareMeta?.configTemplate,
          });
          loadedPinmapIds.push(pinmapId);
          continue; // 软件组件不加载引脚摘要
        }
        
        // 加载引脚摘要（硬件组件）
        const summary = connectionGraphService.loadPinSummaryById(pinmapId, packagesBasePath);
        if (summary) {
          // 多实例时需要修改 componentId 使其唯一（添加别名后缀）
          const modifiedSummary: PinSummary = {
            ...summary,
            componentId: alias,  // 使用别名作为唯一标识
            componentName: label || summary.componentName,
          };
          pinSummaries.push(modifiedSummary);
          loadedPinmapIds.push(pinmapId);
          
          componentInstances.push({
            pinmapId,
            alias,
            label,
            instance: instanceIndex,
          });
        } else {
          // 记录加载失败的 pinmapId
          failedPinmapIds.push({
            pinmapId,
            reason: 'pinmap 文件不存在或无法读取。请先使用 get_component_catalog 确认该组件的 pinmap 状态，如果状态为 needs_generation 或 missing_catalog，需先调用 generate_pinmap + save_pinmap 生成配置。',
          });
        }
      }
    }

    // 3. 处理 components（旧版兼容 / fallback）
    const notFoundComponents: string[] = [];
    // 确保 components 是字符串数组（兼容 LLM 传入对象数组的情况）
    let componentList: string[] = [];
    if (input.components) {
      let rawComponents: any[] = [];
      if (Array.isArray(input.components)) {
        rawComponents = input.components;
      } else if (typeof input.components === 'string') {
        try {
          const parsed = JSON.parse(input.components);
          rawComponents = Array.isArray(parsed) ? parsed : [input.components];
        } catch {
          rawComponents = [input.components];
        }
      }
      for (const item of rawComponents) {
        if (typeof item === 'string') {
          // 普通字符串：直接用作组件名
          componentList.push(item);
        } else if (item && typeof item === 'object') {
          // 对象：优先取 pinmapId，其次取 componentId/componentName 用于搜索
          if (item.pinmapId && typeof item.pinmapId === 'string') {
            // 如果带完整 pinmapId，直接通过 pinmapId 路径加载，不走 catalog 搜索
            if (!loadedPinmapIds.includes(item.pinmapId) && packagesBasePath) {
              const softwareCheck = connectionGraphService.checkSoftwareComponent(item.pinmapId, packagesBasePath);
              if (softwareCheck.isSoftware && softwareCheck.catalog) {
                const catalog = softwareCheck.catalog;
                const alias = item.refId || connectionGraphService.parsePinmapId(item.pinmapId).modelId;
                softwareComponents.push({
                  pinmapId: item.pinmapId,
                  alias,
                  label: item.componentName,
                  libraryType: catalog.softwareMeta?.libraryType || 'other',
                  displayName: catalog.displayName,
                  configTemplate: catalog.softwareMeta?.configTemplate,
                });
                loadedPinmapIds.push(item.pinmapId);
              } else {
                const summary = connectionGraphService.loadPinSummaryById(item.pinmapId, packagesBasePath);
                if (summary) {
                  const alias = item.refId || connectionGraphService.parsePinmapId(item.pinmapId).modelId;
                  pinSummaries.push({ ...summary, componentId: alias, componentName: item.componentName || summary.componentName });
                  loadedPinmapIds.push(item.pinmapId);
                  componentInstances.push({ pinmapId: item.pinmapId, alias, label: item.componentName, instance: 0 });
                } else {
                  // 记录加载失败
                  failedPinmapIds.push({
                    pinmapId: item.pinmapId,
                    reason: 'pinmap 文件不存在',
                  });
                }
              }
            }
          } else {
            // 没有 pinmapId：降级使用 componentId 或 componentName 文本搜索
            const name = item.componentId || item.componentName;
            if (name && typeof name === 'string') {
              componentList.push(name);
            }
          }
        }
      }
    }
    if (componentList.length > 0 && packagesBasePath) {
      // 扫描所有 catalog 查找匹配的组件
      const catalogs = connectionGraphService.scanPinmapCatalogs(packagesBasePath);
      for (const compName of componentList) {
        const found = findComponentInCatalogs(compName, catalogs, connectionGraphService, packagesBasePath);
        if (found) {
          if (!loadedPinmapIds.includes(found.fullId)) {
            pinSummaries.push(found.summary);
            loadedPinmapIds.push(found.fullId);
          }
        } else {
          notFoundComponents.push(compName);
        }
      }
    }

    // 4. 如果没有指定任何组件，扫描已有的外设配置（旧版方式）
    if (loadedPinmapIds.length === 0) {
      const peripheralConfigs = connectionGraphService.findPeripheralConfigs(boardPackagePath);
      for (const configPath of peripheralConfigs) {
        const config = connectionGraphService.readComponentConfig(configPath);
        if (config) {
          pinSummaries.push(connectionGraphService.extractPinSummary(config));
        }
      }
    }

    // 不再返回完整的 systemPrompt/userPrompt，工具 description 已包含规则
    // LLM 根据 pinSummaries + instructions 生成连线 JSON 即可

    // 如果只有开发板，没有硬件外设（但可能有软件组件）
    if (pinSummaries.length <= 1 && softwareComponents.length === 0) {
      let message = '当前只检测到开发板的引脚配置，未发现外设配置。';
      if (failedPinmapIds.length > 0) {
        message += `\n\n⚠️ 以下 pinmapId 加载失败（pinmap 文件不存在）：`;
        for (const f of failedPinmapIds) {
          message += `\n- ${f.pinmapId}: ${f.reason}`;
        }
      }
      if (notFoundComponents.length > 0) {
        message += `\n未找到以下组件的 pinmap: ${notFoundComponents.join(', ')}`;
      }
      message += '\n\n提示：请先使用 get_component_catalog 工具确认组件的 pinmap 状态（status 字段），只有 status=available 的组件才可用于生成连线。';

      return {
        is_error: failedPinmapIds.length > 0,  // 如果有加载失败则标记为错误
        content: JSON.stringify({
          message,
          failedPinmapIds: failedPinmapIds.length > 0 ? failedPinmapIds : undefined,
          pinSummaries,
          loadedPinmapIds,
          componentInstances: componentInstances.length > 0 ? componentInstances : undefined,
          instructions: failedPinmapIds.length > 0
            ? '请先调用 get_component_catalog 确认组件状态，再使用 generate_pinmap + save_pinmap 为缺失配置的组件生成 pinmap。'
            : '请根据上面的引脚信息和用户需求，输出符合 connection_output.json 格式的连线 JSON。输出完成后，请调用 validate_schematic 工具验证连线安全性。',
        }, null, 2),
      };
    }

    // 如果只有软件组件，也允许继续（但不需要物理连线）
    if (pinSummaries.length <= 1 && softwareComponents.length > 0) {
      const softwareDetails = softwareComponents.map(sc => {
        let detail = `- ${sc.alias}: ${sc.displayName} (${sc.libraryType})`;
        if (sc.configTemplate && sc.configTemplate.length > 0) {
          const configItems = sc.configTemplate.map((ct: any) => `${ct.label}(${ct.key})`).join(', ');
          detail += `\n  需要配置: ${configItems}`;
        }
        return detail;
      }).join('\n');

      return {
        is_error: false,
        content: JSON.stringify({
          message: '检测到软件/云端通信组件（无物理引脚），不需要生成物理连线图。',
          softwareComponents,
          softwareComponentsNote: `以下软件组件将在连线图中以信息卡片形式展示：\n${softwareDetails}`,
          instructions: `请在 connection_output.json 的 components 数组中添加软件组件，设置 componentType: "software" 和 softwareConfig 字段。
示例：
{
  "refId": "${softwareComponents[0]?.alias || 'wifi'}",
  "componentId": "${softwareComponents[0]?.displayName || 'WiFi'}",
  "componentName": "${softwareComponents[0]?.label || softwareComponents[0]?.displayName || 'WiFi 模块'}",
  "pinmapId": "${softwareComponents[0]?.pinmapId || 'lib-wifi:default:default'}",
  "componentType": "software",
  "softwareConfig": {
    "libraryType": "${softwareComponents[0]?.libraryType || 'wifi'}",
    "icon": "wifi",
    "properties": {
      "ssid": "MyNetwork",
      "password": "********"
    }
  }
}

请询问用户需要配置的属性值，然后生成完整的配置。`,
        }, null, 2),
      };
    }

    // 构建多实例说明（如果有）
    let multiInstanceNote = '';
    if (componentInstances.length > 0) {
      const instanceDetails = componentInstances.map(ci => 
        `- ${ci.alias}: pinmapId="${ci.pinmapId}"${ci.label ? `, 名称="${ci.label}"` : ''}`
      ).join('\n');
      multiInstanceNote = `

### 组件实例映射
以下是组件的 refId（别名）与 pinmapId 的对应关系，在 JSON 中 from.ref / to.ref 字段使用 refId：
${instanceDetails}
`;
    }

    // 构建软件组件说明（如果有）
    let softwareComponentNote = '';
    if (softwareComponents.length > 0) {
      const softwareDetails = softwareComponents.map(sc => {
        let detail = `- ${sc.alias}: ${sc.displayName} (${sc.libraryType})`;
        if (sc.configTemplate && sc.configTemplate.length > 0) {
          const configItems = sc.configTemplate.map(ct => `${ct.label}(${ct.key})`).join(', ');
          detail += `\n  配置项: ${configItems}`;
        }
        return detail;
      }).join('\n');
      softwareComponentNote = `

### 软件组件（无物理连接）
以下组件是软件/云端通信库，不需要物理引脚连接，在连线图中以信息卡片形式展示：
${softwareDetails}

在 components 数组中，软件组件需要设置 componentType: "software" 和 softwareConfig 字段。
`;
    }

    // 构建失败组件警告
    let failedComponentsWarning = '';
    if (failedPinmapIds.length > 0) {
      failedComponentsWarning = `

### ⚠️ 以下组件的 pinmap 加载失败
${failedPinmapIds.map(f => `- ${f.pinmapId}: ${f.reason}`).join('\n')}

这些组件无法生成连线，请先调用 get_component_catalog 确认其状态，再使用 generate_pinmap + save_pinmap 生成配置。`;
    }

    const result: any = {
      pinSummaries,
      loadedPinmapIds,
      failedPinmapIds: failedPinmapIds.length > 0 ? failedPinmapIds : undefined,
      componentInstances: componentInstances.length > 0 ? componentInstances : undefined,
      softwareComponents: softwareComponents.length > 0 ? softwareComponents : undefined,
      notFoundComponents: notFoundComponents.length > 0 ? notFoundComponents : undefined,
      instructions: `请根据上面的引脚信息和分析规则，输出符合格式要求的连线 JSON。确保：
1. 每条连线都有正确的 from/to 端点（ref + pinId + function）
2. type 和 color 对应正确
3. 电源、接地、通信线齐全
4. components 数组中每个组件的 refId 使用指定的别名（如 "dht_indoor"）
5. components 数组中的 pinmapId 字段使用完整标识符（如 "${loadedPinmapIds[0] || 'lib-dht:dht20:asair'}"）
6. 多实例组件需设置 instance 字段（0-based）
7. 连线的 from.ref / to.ref 使用组件的 refId（别名）
8. 软件组件需设置 componentType: "software" 和 softwareConfig 字段（包含 libraryType、properties 等）
9. 输出完成后请调用 validate_schematic 工具验证安全性。${multiInstanceNote}${softwareComponentNote}${failedComponentsWarning}`,
    };

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return injectTodoReminder(toolResult, 'generate_schematic');
  } catch (error: any) {
    return {
      is_error: true,
      content: `生成连线图失败: ${error.message || error}`,
    };
  }
}

/**
 * get_pinmap_summary 工具
 *
 * 获取当前项目的引脚摘要信息，供 Agent 了解可用引脚。
 * 支持通过 pinmapIds 参数指定具体的传感器变体。
 */
export async function getPinmapSummaryTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapIds?: string[] }
): Promise<ToolUseResult> {
  try {
    const boardPackagePath = await projectService.getBoardPackagePath();
    if (!boardPackagePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目或未安装开发板包。',
      };
    }

    // 直接使用 currentProjectPath 构建 packagesBasePath（参考 getContextTool.ts）
    const currentProjectPath = projectService.currentProjectPath;
    // 使用字符串模板确保类型正确
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;
    const pinSummaries: PinSummary[] = [];
    const loadedPinmapIds: string[] = [];

    // 1. 添加开发板引脚摘要
    const boardSummary = connectionGraphService.getBoardPinSummary(boardPackagePath);
    if (boardSummary) {
      pinSummaries.push(boardSummary);
    }

    // 2. 如果指定了 pinmapIds，加载对应的摘要
    // 确保 pinmapIds 是数组（Agent 可能传入字符串）
    let pinmapIdList: string[] = [];
    if (input.pinmapIds) {
      if (Array.isArray(input.pinmapIds)) {
        pinmapIdList = input.pinmapIds;
      } else if (typeof input.pinmapIds === 'string') {
        try {
          const parsed = JSON.parse(input.pinmapIds);
          pinmapIdList = Array.isArray(parsed) ? parsed : [input.pinmapIds];
        } catch {
          pinmapIdList = [input.pinmapIds];
        }
      }
    }
    if (pinmapIdList.length > 0 && packagesBasePath) {
      for (const fullId of pinmapIdList) {
        const summary = connectionGraphService.loadPinSummaryById(fullId, packagesBasePath);
        if (summary) {
          pinSummaries.push(summary);
          loadedPinmapIds.push(fullId);
        }
      }
    }

    if (pinSummaries.length === 0) {
      return {
        is_error: true,
        content: '未找到任何引脚配置文件（pinmap.json）。',
      };
    }

    // 同时返回已有的连线数据（如果存在）
    const existingConnections = connectionGraphService.getConnectionGraph();

    const result: any = {
      pinSummaries,
      loadedPinmapIds: loadedPinmapIds.length > 0 ? loadedPinmapIds : undefined,
    };

    if (existingConnections) {
      result.existingConnectionGraph = {
        description: existingConnections.description,
        componentCount: existingConnections.components.length,
        connectionCount: existingConnections.connections.length,
        components: existingConnections.components.map(c => ({
          refId: c.refId,
          pinmapId: c.pinmapId,
          componentId: c.componentId,
        })),
      };
    }

    // 如果没有指定 pinmapIds，提示可用的传感器
    if (!input.pinmapIds && packagesBasePath) {
      const availableIds = connectionGraphService.getAvailablePinmapIds(packagesBasePath, { status: 'available' });
      if (availableIds.length > 0) {
        result.availableSensorPinmapIds = availableIds.slice(0, 10); // 最多显示 10 个
        result.tip = '使用 get_component_catalog 工具可查看完整的组件目录。';
      }
    }

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return injectTodoReminder(toolResult, 'get_pinmap_summary');
  } catch (error: any) {
    return {
      is_error: true,
      content: `获取引脚摘要失败: ${error.message || error}`,
    };
  }
}

/**
 * get_component_catalog 工具
 *
 * 获取当前项目的组件目录（开发板 + 传感器库 + 软件库）。
 * 对于没有 pinmap_catalog.json 的库，也会列出并标记为 needs_catalog_generation。
 */
export async function getSensorPinmapCatalogTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { libraryFilter?: string; includeNeedsGeneration?: boolean; includeBoards?: boolean }
): Promise<ToolUseResult> {
  try {
    // 直接使用 currentProjectPath 构建路径（参考 getContextTool.ts）
    const currentProjectPath = projectService.currentProjectPath;
    if (!currentProjectPath || currentProjectPath === projectService.projectRootPath) {
      return {
        is_error: true,
        content: '当前没有打开的项目。',
      };
    }

    // node_modules 路径作为 packagesBasePath - 使用字符串拼接确保类型正确
    const packagesBasePath = `${currentProjectPath}/node_modules`;
    if (!window['fs'].existsSync(packagesBasePath)) {
      return {
        is_error: true,
        content: '项目的 node_modules 目录不存在，请先安装依赖。',
      };
    }

    // 使用 scanAllLibraries 扫描所有 lib-* 库（包括没有 catalog 的）
    let libraryResults = connectionGraphService.scanAllLibraries(packagesBasePath);

    // 过滤库
    if (input.libraryFilter) {
      libraryResults = libraryResults.filter(lib => {
        return lib.packageSlug === input.libraryFilter ||
               lib.packageSlug === `lib-${input.libraryFilter}` ||
               `@aily-project/${lib.packageSlug}` === input.libraryFilter;
      });
    }

    // 构建输出结果
    const catalogsWithPinmap: any[] = [];  // 有 catalog 的硬件库
    let boardCatalog: any = null;  // 当前开发板的 catalog

    // 如果 includeBoards 为 true，获取当前项目的开发板 catalog
    if (input.includeBoards) {
      try {
        const boardPackagePath = await projectService.getBoardPackagePath();
        if (boardPackagePath) {
          // 读取开发板的 pinmap_catalog.json
          const catalog = connectionGraphService.readPinmapCatalog(boardPackagePath);
          if (catalog) {
            // 从包路径提取 packageSlug（如 board-xiao_esp32s3）
            const boardPkgName = boardPackagePath.split(/[\\/]/).pop() || '';
            boardCatalog = {
              packageSlug: boardPkgName,
              displayName: catalog.displayName,
              type: 'board',
              icon: catalog.icon,
              catalogStatus: 'available',
              isCurrentBoard: true,
              models: catalog.models.map(model => ({
                id: model.id,
                name: model.name,
                description: model.description,
                defaultVariant: model.defaultVariant,
                variants: model.variants
                  .filter(v => input.includeNeedsGeneration !== false || v.status === 'available')
                  .map(v => ({
                    id: v.id,
                    name: v.name,
                    fullId: v.fullId,
                    protocol: v.protocol,
                    manufacturer: v.manufacturer,
                    status: v.status,
                    isDefault: v.isDefault,
                    previewPins: v.previewPins,
                  })),
              })).filter(m => m.variants.length > 0),
            };
          } else {
            // 开发板没有 pinmap_catalog.json，检查是否有 pinmap.json（旧版格式）
            const boardConfig = connectionGraphService.getBoardConfig(boardPackagePath);
            const boardPkgName = boardPackagePath.split(/[\\/]/).pop() || '';
            if (boardConfig) {
              boardCatalog = {
                packageSlug: boardPkgName,
                displayName: boardConfig.name || boardPkgName,
                type: 'board',
                catalogStatus: 'legacy_pinmap',
                isCurrentBoard: true,
                tip: '该开发板使用旧版 pinmap.json 格式，可直接使用。如需更新可使用 generate_pinmap 工具。',
                pinmapId: `${boardPkgName}:${boardConfig.id || 'default'}:default`,
              };
            } else {
              // 开发板既没有 catalog 也没有 pinmap.json
              boardCatalog = {
                packageSlug: boardPkgName,
                displayName: boardPkgName,
                type: 'board',
                catalogStatus: 'missing',
                isCurrentBoard: true,
                tip: `当前开发板缺少 pinmap 配置，使用 generate_pinmap 工具生成配置，pinmapId 格式：${boardPkgName}:{modelId}:default`,
              };
            }
          }
        }
      } catch (e) {
        console.error('获取开发板 catalog 失败:', e);
      }
    }
    const softwareLibraries: any[] = [];   // 软件类型的库（WiFi/MQTT等）
    const librariesMissingCatalog: any[] = [];  // 没有 catalog 的库

    for (const lib of libraryResults) {
      if (lib.hasPinmapCatalog && lib.catalog) {
        // 有 pinmap_catalog.json 的库
        const catalog = lib.catalog;
        // 过滤开发板
        if (!input.includeBoards && catalog.type === 'board') continue;

        // 软件类型的库单独处理
        if (catalog.type === 'software') {
          softwareLibraries.push({
            packageSlug: lib.packageSlug,
            displayName: catalog.displayName,
            type: 'software',
            icon: catalog.icon || catalog.softwareMeta?.defaultIcon,
            libraryType: catalog.softwareMeta?.libraryType || 'other',
            configTemplate: catalog.softwareMeta?.configTemplate,
            catalogStatus: 'available',
            usage: '软件库不需要引脚连接，在连线图中显示为信息卡片',
          });
          continue;
        }

        catalogsWithPinmap.push({
          packageSlug: lib.packageSlug,
          displayName: catalog.displayName,
          type: catalog.type || 'library',
          icon: catalog.icon,
          catalogStatus: 'available',
          models: catalog.models.map(model => ({
            id: model.id,
            name: model.name,
            description: model.description,
            defaultVariant: model.defaultVariant,
            variants: model.variants
              .filter(v => input.includeNeedsGeneration !== false || v.status === 'available')
              .map(v => ({
                id: v.id,
                name: v.name,
                fullId: v.fullId,
                protocol: v.protocol,
                manufacturer: v.manufacturer,
                status: v.status,
                isDefault: v.isDefault,
                previewPins: v.previewPins,
              })),
          })).filter(m => m.variants.length > 0),
        });
      } else {
        // 没有 pinmap_catalog.json 的库
        librariesMissingCatalog.push({
          packageSlug: lib.packageSlug,
          displayName: lib.displayName,
          catalogStatus: 'missing_catalog',
          tip: `使用 generate_pinmap 工具为此库生成配置，pinmapId 格式：${lib.packageSlug}:{modelId}:{variantId}`,
        });
      }
    }

    // 过滤掉没有有效 models 的 catalog
    const validCatalogs = catalogsWithPinmap.filter(c => c.models && c.models.length > 0);

    // 构建结果
    const resultContent: any = {};

    // 添加开发板 catalog（如果有）
    if (boardCatalog) {
      resultContent.currentBoard = boardCatalog;
    }

    if (validCatalogs.length > 0) {
      resultContent.catalogCount = validCatalogs.length;
      resultContent.catalogs = validCatalogs;
      resultContent.usage = '使用 fullId（如 "lib-dht:dht20:asair"）作为 generate_schematic 的 pinmapIds 参数';
    }

    if (softwareLibraries.length > 0) {
      resultContent.softwareLibraries = softwareLibraries;
      resultContent.softwareUsage = '软件库（WiFi/MQTT/HTTP等）不需要物理引脚连接。在连线图中以信息卡片形式展示，使用 packageSlug 作为 generate_schematic 的 pinmapIds 参数（格式：{packageSlug}:default:default）';
    }

    if (librariesMissingCatalog.length > 0) {
      resultContent.librariesMissingCatalog = librariesMissingCatalog;
      resultContent.missingCatalogTip = '这些库没有 pinmap_catalog.json，你可以使用 generate_pinmap 工具为它们生成 pinmap 配置';
    }

    if (validCatalogs.length === 0 && softwareLibraries.length === 0 && librariesMissingCatalog.length === 0) {
      return {
        is_error: false,
        content: JSON.stringify({
          message: '未找到已安装的 lib-* 传感器库。',
          tip: '请先安装传感器库，如 npm install @aily-project/lib-dht',
        }, null, 2),
      };
    }

    if (validCatalogs.length === 0 && softwareLibraries.length === 0 && librariesMissingCatalog.length > 0) {
      // 只有没有 catalog 的库
      resultContent.message = '已安装的库都没有 pinmap_catalog.json 配置文件';
    }

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(resultContent, null, 2),
    };
    return injectTodoReminder(toolResult, 'get_component_catalog');
  } catch (error: any) {
    return {
      is_error: true,
      content: `获取传感器目录失败: ${error.message || error}`,
    };
  }
}

/**
 * validate_schematic 工具
 *
 * 验证连线配置的安全性，检查短路、电压不匹配、引脚冲突等问题。
 * 如果传入 connection_data 则验证该数据并保存；否则验证项目中已保存的连线。
 */
export async function validateConnectionGraphTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { connection_data?: any }
): Promise<ToolUseResult> {
  try {
    let data = input.connection_data
      ? connectionGraphService.parseConnectionGraphJSON(
          typeof input.connection_data === 'string'
            ? input.connection_data
            : JSON.stringify(input.connection_data)
        )
      : connectionGraphService.getConnectionGraph();

    if (!data) {
      return {
        is_error: true,
        content: '没有可验证的连线数据。请先使用 generate_schematic 工具生成连线，或传入 connection_data 参数。',
      };
    }

    // 运行安全检查
    const validationResults = connectionGraphService.validateConnectionGraph(data);

    // 如果传入了新数据，保存到项目文件
    if (input.connection_data) {
      const saved = connectionGraphService.saveConnectionGraph(data);
      if (!saved) {
        return {
          is_error: true,
          content: '连线数据验证完成但保存失败，请检查项目路径。',
        };
      }

      // 尝试通知 iframe 更新
      try {
        const boardPackagePath = await projectService.getBoardPackagePath();
        if (boardPackagePath) {
          await connectionGraphService.notifyIframe(data, boardPackagePath);
        }
      } catch {
        // iframe 通知失败不影响主流程
      }
    }

    const errors = validationResults.filter(r => r.level === 'error');
    const warnings = validationResults.filter(r => r.level === 'warning');

    const result = {
      valid: errors.length === 0,
      saved: !!input.connection_data,
      summary: {
        totalConnections: data.connections.length,
        totalComponents: data.components.length,
        errors: errors.length,
        warnings: warnings.length,
      },
      issues: validationResults.length > 0 ? validationResults : undefined,
      message: errors.length === 0
        ? (warnings.length > 0
          ? `连线配置基本安全，但有 ${warnings.length} 条警告需要注意。${input.connection_data ? '数据已保存。' : ''}`
          : `连线配置安全，所有检查通过。${input.connection_data ? '数据已保存。' : ''}`)
        : `发现 ${errors.length} 个安全问题，请修正后重新验证。`,
      tip: '用户可以点击右侧工具栏的「查看接线」按钮查看连线图。',
    };

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return injectTodoReminder(toolResult, 'validate_schematic');
  } catch (error: any) {
    return {
      is_error: true,
      content: `验证连线配置失败: ${error.message || error}`,
    };
  }
}
// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 在所有 catalog 中查找匹配的组件（通过简称）
 */
function findComponentInCatalogs(
  compName: string,
  catalogs: PinmapCatalog[],
  connectionGraphService: ConnectionGraphService,
  packagesBasePath: string
): { fullId: string; summary: PinSummary } | null {
  const lowerName = compName.toLowerCase();

  for (const catalog of catalogs) {
    for (const model of catalog.models) {
      // 匹配 model.id 或 model.name
      if (model.id.toLowerCase() === lowerName ||
          model.name.toLowerCase().includes(lowerName)) {
        // 找到匹配的 model，返回默认变体
        const defaultVariant = model.variants.find(v => v.isDefault) || model.variants[0];
        if (defaultVariant && defaultVariant.status === 'available') {
          const summary = connectionGraphService.loadPinSummaryById(defaultVariant.fullId, packagesBasePath);
          if (summary) {
            return { fullId: defaultVariant.fullId, summary };
          }
        }
      }
    }
  }

  return null;
}

// =============================================================================
// Pinmap 生成工具
// =============================================================================

/**
 * generate_pinmap 工具
 *
 * 为缺失 pinmap 的组件（开发板、传感器、模块等）生成配置。返回包文档、示例代码和模板，供 LLM 生成完整的 pinmap JSON。
 */
export async function generatePinmapTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapId: string; referenceSource?: 'readme' | 'example' | 'auto' }
): Promise<ToolUseResult> {
  try {
    if (!input.pinmapId) {
      return {
        is_error: true,
        content: '缺少必需参数 pinmapId。请提供目标组件的完整标识符，如 "lib-servo:sg90:default"。',
      };
    }

    const currentProjectPath = projectService.currentProjectPath;
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;

    if (!packagesBasePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目，无法定位组件包。',
      };
    }

    // 解析 pinmapId
    const ref = connectionGraphService.parsePinmapId(input.pinmapId);

    // 查找变体信息
    const variantInfo = connectionGraphService.findVariantInfo(input.pinmapId, packagesBasePath);
    
    // 获取库信息
    const libraryInfo = connectionGraphService.getLibraryInfo(input.pinmapId, packagesBasePath);

    // 获取协议对应的模板
    const protocol = variantInfo?.protocol || 'other';
    const template = connectionGraphService.getPinmapTemplate(protocol as PinmapProtocol);

    // 如果已有同库的其他 pinmap，读取一个作为参考
    let existingPinmapExample: ComponentConfig | null = null;
    if (libraryInfo.existingPinmaps && libraryInfo.existingPinmaps.length > 0) {
      const packagePath = `${packagesBasePath}/@aily-project/${ref.packageSlug}`;
      const exampleFileName = libraryInfo.existingPinmaps[0];
      const examplePath = `${packagePath}/pinmaps/${exampleFileName}`;
      existingPinmapExample = connectionGraphService.readComponentConfig(examplePath);
    }

    // 构建返回结果
    const result: any = {
      targetPinmapId: input.pinmapId,
      parsedRef: ref,
      variantInfo: variantInfo ? {
        name: variantInfo.name,
        protocol: variantInfo.protocol,
        manufacturer: variantInfo.manufacturer,
        voltage: variantInfo.voltage,
        note: variantInfo.note,
      } : undefined,
    };

    // 根据 referenceSource 决定返回哪些信息
    const source = input.referenceSource || 'auto';
    
    if (source === 'auto' || source === 'readme') {
      if (libraryInfo.readme) {
        result.readme = libraryInfo.readme;
      }
    }

    if (source === 'auto' || source === 'example') {
      if (libraryInfo.exampleCode) {
        result.exampleCode = libraryInfo.exampleCode;
      }
    }

    // 总是返回模板和现有示例
    result.pinmapTemplate = template;
    if (existingPinmapExample) {
      result.existingPinmapExample = existingPinmapExample;
    }

    // 生成指导说明
    result.instructions = `请根据以上信息生成完整的 pinmap 配置 JSON。

## 要求

1. **id**: 使用 "component_${ref.modelId}_${ref.variantId}" 格式
2. **name**: 组件的中文名称
3. **width/height**: 组件图形的宽高（像素），建议 200x100 或根据引脚数量调整
4. **images**: 组件图片数组（可以先用占位图 "images/placeholder.png"）
5. **pins**: 引脚数组，每个引脚包含：
   - id: "pin_1", "pin_2" 等
   - x, y: 引脚在图形上的位置
   - layout: "horizontal" 或 "vertical"
   - functions: 引脚功能数组，每个功能有 name 和 type
6. **functionTypes**: 功能类型定义（颜色映射）

## 引脚功能类型对照

| type | 说明 | 示例 name |
|------|------|-----------|
| power | 电源 | VCC, 3V3, 5V, VIN |
| gnd | 接地 | GND |
| i2c | I2C 通信 | SDA, SCL |
| spi | SPI 通信 | MOSI, MISO, SCK, CS |
| uart | 串口 | TX, RX |
| pwm | PWM 信号 | SIG, PWM |
| digital | 数字信号 | OUT, IN, DATA |
| analog | 模拟信号 | AOUT, AIN |

## 输出格式

生成完整的 JSON 后，调用 save_pinmap 工具保存：
\`\`\`
save_pinmap(pinmapId="${input.pinmapId}", pinmapConfig={生成的JSON})
\`\`\`

**注意**：save_pinmap 工具会自动：
1. 将 pinmap 文件保存到 \`pinmaps/${ref.modelId}_${ref.variantId}.json\`
2. 创建或更新 \`pinmap_catalog.json\`（如果不存在会自动创建）
3. 将变体状态设置为 "available"`;

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return injectTodoReminder(toolResult, 'generate_pinmap');
  } catch (error: any) {
    return {
      is_error: true,
      content: `获取 pinmap 生成信息失败: ${error.message || error}`,
    };
  }
}

/**
 * save_pinmap 工具
 *
 * 保存 LLM 生成的 pinmap 配置到库目录，并更新 catalog 状态。
 */
export async function savePinmapTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapId: string; pinmapConfig: ComponentConfig | string }
): Promise<ToolUseResult> {
  try {
    if (!input.pinmapId) {
      return {
        is_error: true,
        content: '缺少必需参数 pinmapId。',
      };
    }

    if (!input.pinmapConfig) {
      return {
        is_error: true,
        content: '缺少必需参数 pinmapConfig。请提供完整的 pinmap 配置 JSON。',
      };
    }

    const currentProjectPath = projectService.currentProjectPath;
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;

    if (!packagesBasePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目，无法保存 pinmap。',
      };
    }

    // 解析 pinmapConfig（可能是字符串或对象）
    let config: ComponentConfig;
    if (typeof input.pinmapConfig === 'string') {
      try {
        config = JSON.parse(input.pinmapConfig);
      } catch (e) {
        return {
          is_error: true,
          content: 'pinmapConfig 不是有效的 JSON 格式。',
        };
      }
    } else {
      config = input.pinmapConfig;
    }

    // 基本验证
    if (!config.id || !config.name || !config.pins || !Array.isArray(config.pins)) {
      return {
        is_error: true,
        content: 'pinmapConfig 缺少必需字段（id, name, pins）。请确保配置完整。',
      };
    }

    // 保存 pinmap
    const saveResult = connectionGraphService.savePinmapConfig(input.pinmapId, config, packagesBasePath);

    if (!saveResult.success) {
      return {
        is_error: true,
        content: `保存 pinmap 失败: ${saveResult.error}`,
      };
    }

    const result = {
      success: true,
      pinmapId: input.pinmapId,
      filePath: saveResult.filePath,
      message: `Pinmap 配置已保存到 ${saveResult.filePath}，catalog 状态已更新为 "available"。`,
      tip: '现在可以在 generate_schematic 工具中使用此 pinmapId 了。',
    };

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return injectTodoReminder(toolResult, 'save_pinmap');
  } catch (error: any) {
    return {
      is_error: true,
      content: `保存 pinmap 失败: ${error.message || error}`,
    };
  }
}