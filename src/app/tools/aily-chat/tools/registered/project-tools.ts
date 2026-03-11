/**
 * 已注册工具 - 项目与系统操作类
 */

import { IAilyTool, ToolContext, ToolUseResult } from '../../core/tool-types';
import { ToolRegistry } from '../../core/tool-registry';
import { newProjectTool as newProjectHandler } from '../createProjectTool';
import { executeCommandTool as executeCommandHandler } from '../executeCommandTool';
import { getContextTool as getContextHandler } from '../getContextTool';
import { getProjectInfoTool as getProjectInfoHandler } from '../getProjectInfoTool';
import { buildProjectTool as buildProjectHandler } from '../buildProjectTool';
import { reloadProjectTool as reloadProjectHandler } from '../reloadProjectTool';
import { askApprovalTool as askApprovalHandler } from '../askApprovalTool';
import { searchBoardsLibrariesTool } from '../searchBoardsLibrariesTool';
import { getHardwareCategoriesTool } from '../getHardwareCategoriesTools';
import { getBoardParametersTool } from '../getBoardParametersTool';
import { fetchTool as fetchHandler } from '../fetchTool';
import { webSearchTool as webSearchHandler } from '../webSearchTool';
import { todoWriteTool as todoWriteHandler, injectTodoReminder } from '../todoWriteTool';
import { TOOLS as LEGACY_TOOLS } from '../tools';

function findLegacySchema(name: string): any {
  return (LEGACY_TOOLS as any[]).find(t => t.name === name);
}

// ============================
// create_project
// ============================

class CreateProjectTool implements IAilyTool {
  readonly name = 'create_project';
  readonly schema = findLegacySchema('create_project');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    const result = await newProjectHandler(ctx.host!.project.projectRootPath || '', args, ctx.host!.project as any, ctx.host!.config as any);
    if (!result.is_error) {
      // Signal to post-switch logic that Blockly rules injection is needed
      result.metadata = { ...result.metadata, newProject: true };
    }
    return result;
  }

  getStartText() { return '正在创建项目...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '项目创建异常,即将重试';
    return '项目创建成功';
  }
}

// ============================
// execute_command
// ============================

class ExecuteCommandTool implements IAilyTool {
  readonly name = 'execute_command';
  readonly schema = findLegacySchema('execute_command');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    const host = ctx.host!;
    if (!args.cwd && host.project) {
      args.cwd = host.project.currentProjectPath || host.project.projectRootPath;
    }

    const projectPath = args.cwd || host.project.currentProjectPath;
    const command = args.command || '';
    const isNpmInstall = command.includes('npm i') || command.includes('npm install');
    const isNpmUninstall = command.includes('npm uninstall');
    let unloadResults: string[] = [];

    // Pre-execution: npm uninstall → check blocks in use → unload libraries
    if (isNpmUninstall && host.blockly && host.platform) {
      const npmRegex = /@aily-project\/[a-zA-Z0-9-_]+/g;
      const matches = command.match(npmRegex);

      if (matches && matches.length > 0) {
        const uniqueLibs = [...new Set(matches)];
        const separator = host.platform.pathSeparator;
        const libsInUse: string[] = [];

        for (const libPackageName of uniqueLibs as string[]) {
          try {
            const libBlockPath = projectPath + `${separator}node_modules${separator}` + libPackageName + `${separator}block.json`;
            if (host.fs.existsSync(libBlockPath)) {
              const blocksData = JSON.parse(host.fs.readFileSync(libBlockPath, 'utf-8'));
              const abiJson = JSON.stringify(host.blockly.getWorkspaceJson());
              for (const element of blocksData) {
                if (abiJson.includes(element.type)) {
                  libsInUse.push(libPackageName);
                  break;
                }
              }
            }
          } catch (e) {
            console.warn('检查库使用情况失败:', libPackageName, e);
          }
        }

        if (libsInUse.length > 0) {
          return {
            content: `无法卸载以下库，因为项目代码正在使用它们：${libsInUse.join(', ')}。请先删除相关代码块后再尝试卸载。`,
            is_error: true
          };
        }

        for (const libPackageName of uniqueLibs) {
          try {
            await host.blockly.unloadLibrary(libPackageName, projectPath);
            unloadResults.push(`${libPackageName} 卸载成功`);
          } catch (e: any) {
            console.warn('卸载库失败:', libPackageName, e);
            unloadResults.push(`${libPackageName} 卸载失败: ${e.message || e}`);
          }
        }
      }
    }

    // Execute the command
    const toolResult: ToolUseResult = await executeCommandHandler(host.cmd, args, ctx.securityContext);

    // Post-execution: append uninstall results
    if (isNpmUninstall && unloadResults.length > 0) {
      toolResult.content = (toolResult.content || '') + `\n\n库卸载结果:\n${unloadResults.join('\n')}`;
    }

    // Post-execution: npm install → load libraries
    if (!toolResult.is_error && isNpmInstall && host.blockly && host.platform) {
      const installSeparator = host.platform.pathSeparator;
      const libsToLoad: string[] = [];

      // 1. Match @aily-project/xxx scoped packages
      const npmRegex = /@aily-project\/[a-zA-Z0-9-_]+/g;
      const scopedMatches = command.match(npmRegex);
      if (scopedMatches) libsToLoad.push(...scopedMatches);

      // 2. Match local path installs
      const npmInstallArgMatch = command.match(/npm\s+(?:install|i|ci)\b(.*?)(?:&&|$)/);
      const npmInstallArgs = npmInstallArgMatch ? npmInstallArgMatch[1] : '';
      const tokens = npmInstallArgs.trim().split(/\s+/).map((t: string) => t.replace(/^["']|["']$/g, ''));
      const skipTokens = new Set(['--save', '--save-dev', '-D', '-S', '-g', '--global', '--legacy-peer-deps', '--force']);
      for (const token of tokens) {
        if (!token || skipTokens.has(token) || token.startsWith('-')) continue;
        const isLocalPath = token.startsWith('./') || token.startsWith('../') ||
          token.startsWith('/') || /^[A-Za-z]:[/\\]/.test(token) ||
          token.startsWith('.\\') || token.startsWith('..\\');
        if (isLocalPath) {
          try {
            let fullPath = token;
            if (!(/^[A-Za-z]:[/\\]/.test(token) || token.startsWith('/'))) {
              fullPath = projectPath + installSeparator + token.replace(/[/\\]/g, installSeparator);
            }
            const pkgJsonPath = fullPath.replace(/[/\\]+$/, '') + installSeparator + 'package.json';
            const pkgJson = JSON.parse(host.fs.readFileSync(pkgJsonPath, 'utf-8'));
            if (pkgJson?.name) libsToLoad.push(pkgJson.name);
          } catch (e) {
            console.warn('读取本地包 package.json 失败:', token, e);
          }
        }
      }

      const uniqueLibs = [...new Set(libsToLoad)];
      const loadResults: string[] = [];
      for (const libPackageName of uniqueLibs) {
        try {
          await host.blockly.loadLibrary(libPackageName, projectPath);
          loadResults.push(`${libPackageName} 加载成功`);
        } catch (e: any) {
          console.warn('加载库失败:', libPackageName, e);
          loadResults.push(`${libPackageName} 加载失败: ${e.message || e}`);
        }
      }
      if (loadResults.length > 0) {
        toolResult.content = (toolResult.content || '') + `\n\n库加载结果:\n${loadResults.join('\n')}`;
      }
    }

    // Handle npm install failure: mark as non-retryable (via warning = false, is_error = true stays)
    if (toolResult.is_error && isNpmInstall) {
      // npm install failures should not trigger retry - keep is_error but don't set warning
      toolResult.metadata = { ...toolResult.metadata, npmInstallFailure: true };
    } else if (toolResult.is_error) {
      // Regular command failures should trigger retry
      toolResult.warning = true;
      toolResult.is_error = false;
    }

    return toolResult;
  }

  getStartText(args: any): string {
    const parts = (args?.command || '').trim().split(/\s+/);
    const cmd = parts[0] || 'unknown';
    const cmdArg = parts[1] || '';
    if (cmd.toLowerCase() === 'npm') return `执行: ${cmd} ${cmdArg}`;
    const display = cmdArg.length > 20 ? '...' + cmdArg.slice(-20) : cmdArg;
    return `执行: ${cmd} ${display}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const parts = (args?.command || '').trim().split(/\s+/);
    const cmd = parts[0] || 'unknown';
    const cmdDisplay = cmd.toLowerCase() === 'npm' && parts[1] ? `${cmd} ${parts[1]}` : cmd;

    if (result?.metadata?.npmInstallFailure) {
      return 'npm install命令执行失败，请检查网络或依赖配置';
    }
    if (result?.is_error || result?.warning) {
      return `命令 ${cmdDisplay} 执行异常, 即将重试`;
    }
    return `命令 ${cmdDisplay} 执行成功`;
  }
}

// ============================
// get_context
// ============================

class GetContextTool implements IAilyTool {
  readonly name = 'get_context';
  readonly schema = findLegacySchema('get_context');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return getContextHandler(ctx.host!.project as any, args);
  }

  getStartText() { return '获取 上下文信息...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '获取 上下文信息 异常, 即将重试' : '获取 上下文信息 成功';
  }
}

// ============================
// get_project_info
// ============================

class GetProjectInfoTool implements IAilyTool {
  readonly name = 'get_project_info';
  readonly schema = findLegacySchema('get_project_info');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return getProjectInfoHandler(ctx.host!.project as any, args);
  }

  getStartText() { return '获取 项目信息...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '获取 项目信息 异常, 即将重试' : '获取 项目信息 成功';
  }
}

// ============================
// build_project
// ============================

class BuildProjectTool implements IAilyTool {
  readonly name = 'build_project';
  readonly schema = findLegacySchema('build_project');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return buildProjectHandler(ctx.host!.builder as any, args);
  }

  getStartText() { return '正在编译项目...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '编译失败' : '编译成功';
  }
}

// ============================
// reload_project
// ============================

class ReloadProjectTool implements IAilyTool {
  readonly name = 'reload_project';
  readonly schema = findLegacySchema('reload_project');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return reloadProjectHandler(ctx.host!.project as any, args);
  }

  getStartText() { return '重新加载项目...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '项目重新加载失败' : '项目重新加载成功';
  }
}

// ============================
// ask_approval
// ============================

class AskApprovalTool implements IAilyTool {
  readonly name = 'ask_approval';
  readonly displayMode = 'silent' as const;
  readonly schema = {
    name: 'ask_approval',
    description: '请求用户确认操作',
    input_schema: { type: 'object', properties: {}, required: [] },
    agents: ['mainAgent']
  };

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return askApprovalHandler(args);
  }
}

// ============================
// search_boards_libraries
// ============================

class SearchBoardsLibrariesTool implements IAilyTool {
  readonly name = 'search_boards_libraries';
  readonly schema = findLegacySchema('search_boards_libraries');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return searchBoardsLibrariesTool.handler(args, ctx.host!.config as any);
  }

  getStartText(args: any): string {
    const searchType = args?.type || 'boards';
    const searchTypeDisplay = searchType === 'boards' ? '开发板' : searchType === 'libraries' ? '库' : '开发板和库';

    let searchDisplayText = '';
    // Parse filters (may be JSON string or object)
    let parsedFilters: any = null;
    if (args?.filters) {
      if (typeof args.filters === 'string') {
        try {
          const trimmed = args.filters.trim();
          if (trimmed && trimmed !== '{}') {
            parsedFilters = JSON.parse(trimmed);
          }
        } catch { /* ignore */ }
      } else if (typeof args.filters === 'object') {
        parsedFilters = args.filters;
      }
    }

    // Prioritize filters.keywords display
    if (parsedFilters?.keywords) {
      const keywords = Array.isArray(parsedFilters.keywords)
        ? parsedFilters.keywords
        : String(parsedFilters.keywords).split(/\s+/);
      if (keywords.length > 0) {
        searchDisplayText = keywords.slice(0, 3).join(', ');
        if (keywords.length > 3) {
          searchDisplayText += ` 等${keywords.length}个关键词`;
        }
      }
    }

    // Show other filter keys (excluding keywords)
    if (parsedFilters) {
      const otherFilterKeys = Object.keys(parsedFilters).filter(k => k !== 'keywords');
      if (otherFilterKeys.length > 0) {
        const filterDisplay = otherFilterKeys.slice(0, 3).map(k => {
          const val = parsedFilters[k];
          if (Array.isArray(val)) return `${k}:[${val.slice(0, 2).join(',')}${val.length > 2 ? '...' : ''}]`;
          return `${k}:${val}`;
        }).join(', ');
        searchDisplayText += searchDisplayText ? ` + ${filterDisplay}` : filterDisplay;
      }
    }

    if (!searchDisplayText) searchDisplayText = '未知查询';
    return `正在搜索${searchTypeDisplay}: ${searchDisplayText}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const searchType = args?.type || 'boards';
    const searchTypeDisplay = searchType === 'boards' ? '开发板' : searchType === 'libraries' ? '库' : '开发板和库';
    if (result?.is_error) return `搜索 ${searchTypeDisplay} 失败: ${result?.content || '未知错误'}`;
    const totalMatches = result?.metadata?.totalMatches || 0;
    // Build search summary for display
    let searchDisplayText = this.getStartText(args).replace(/^正在搜索[^:]*:\s*/, '');
    const searchSummary = searchDisplayText.length > 20 ? searchDisplayText.substring(0, 20) + '...' : searchDisplayText;
    return `搜索 ${searchTypeDisplay} 「${searchSummary}」完成，找到 ${totalMatches} 个匹配项`;
  }
}

// ============================
// get_hardware_categories
// ============================

class GetHardwareCategoriesTool implements IAilyTool {
  readonly name = 'get_hardware_categories';
  readonly schema = findLegacySchema('get_hardware_categories');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return getHardwareCategoriesTool.handler(args, ctx.host!.config as any);
  }

  getStartText(args: any): string {
    const type = args?.type === 'boards' ? '开发板' : '库';
    return `正在获取${type}分类...`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const type = args?.type === 'boards' ? '开发板' : '库';
    if (result?.is_error) return `获取 ${type} 分类失败`;
    const count = result?.metadata?.categories?.length || 0;
    return `获取 ${type} 分类完成，共 ${count} 个分类`;
  }
}

// ============================
// get_board_parameters
// ============================

class GetBoardParametersTool implements IAilyTool {
  readonly name = 'get_board_parameters';
  readonly schema = findLegacySchema('get_board_parameters');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return getBoardParametersTool.handler(ctx.host!.project as any, args);
  }

  getStartText(args: any): string {
    const params = Array.isArray(args?.parameters) ? args.parameters.join(', ') : (args?.parameters || '所有参数');
    return `正在获取当前开发板参数 (${params})`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return `获取开发板参数失败`;
    const boardName = result?.metadata?.boardName || '未知';
    return `获取开发板 "${boardName}" 参数成功`;
  }
}

// ============================
// fetch
// ============================

class FetchTool implements IAilyTool {
  readonly name = 'fetch';
  readonly schema = findLegacySchema('fetch');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return fetchHandler(ctx.host!.fetch, args);
  }

  getStartText(args: any): string {
    const url = args?.url || 'unknown';
    return `进行网络请求: ${url}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '网络请求异常，即将重试';
    return `网络请求 ${args?.url || ''} 成功`;
  }
}

// ============================
// web_search
// ============================

class WebSearchTool implements IAilyTool {
  readonly name = 'web_search';
  readonly schema = findLegacySchema('web_search');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return webSearchHandler(ctx.host!.webSearch, args);
  }

  getStartText(args: any): string {
    return `搜索: ${args?.query || ''}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '搜索失败，即将重试';
    const count = result?.metadata?.resultCount || 0;
    return `搜索完成，找到 ${count} 条结果`;
  }
}

// ============================
// todo_write_tool
// ============================

class TodoWriteTool implements IAilyTool {
  readonly name = 'todo_write_tool';
  readonly schema = findLegacySchema('todo_write_tool');
  readonly displayMode = 'silent' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    const todoArgs = { ...args, sessionId: ctx.sessionId };
    return todoWriteHandler(todoArgs);
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return 'TODO操作异常,即将重试';
    const op = args?.operation || 'unknown';
    const itemTitle = args?.content || args?.title || '项目';
    const texts: Record<string, string> = {
      add: `TODO项目添加成功: ${itemTitle}`,
      batch_add: 'TODO项目批量添加成功',
      list: 'TODO列表获取成功',
      update: 'TODO项目更新成功',
      toggle: 'TODO项目状态切换成功',
      delete: 'TODO项目删除成功',
      clear: 'TODO列表清空成功',
      query: 'TODO查询完成',
      stats: 'TODO统计完成',
    };
    return texts[op] || 'TODO操作完成';
  }
}

// ============================
// 注册
// ============================

ToolRegistry.register(new CreateProjectTool());
ToolRegistry.register(new ExecuteCommandTool());
ToolRegistry.register(new GetContextTool());
ToolRegistry.register(new GetProjectInfoTool());
ToolRegistry.register(new BuildProjectTool());
ToolRegistry.register(new ReloadProjectTool());
ToolRegistry.register(new AskApprovalTool());
ToolRegistry.register(new SearchBoardsLibrariesTool());
ToolRegistry.register(new GetHardwareCategoriesTool());
ToolRegistry.register(new GetBoardParametersTool());
ToolRegistry.register(new FetchTool());
ToolRegistry.register(new WebSearchTool());
ToolRegistry.register(new TodoWriteTool());
