---
name: library-migration-guide
description: "Blockly 库转换规范：将 Arduino/ESP32 硬件库转换为 Aily Blockly 兼容格式的完整流程、block.json 设计、generator.js 实现与 toolbox.json 配置。触发词：库转换、迁移、migration、block.json、generator"
metadata:
  version: "2.0.0"
  author: aily-team
  scope: global
  agents: mainAgent
  auto-activate: false
  tags: library,migration,conversion,block-json,generator
---

# Blockly 库转换规范

基于真实转换案例（ArduinoJson、OneButton、MQTT/PubSubClient 等）的系统性指南，帮助将 Arduino 库转换为 Blockly 库。

## 核心原则

1. **用户体验优先**：简化复杂 API，提供直观操作
2. **功能完整**：覆盖原始库核心功能，保持语义一致
3. **智能自动化**：自动处理初始化、变量管理、错误检查
4. **类型安全**：通过约束防止连接错误
5. **开发板适配**：智能适配不同 Arduino 开发板

## 转换流程

```
源码分析 → 块设计 → block.json → generator.js → toolbox.json → 测试
```

## 库目录结构

```
library-name/
├─ block.json        // 块定义
├─ generator.js      // 代码生成器
├─ toolbox.json      // 工具箱配置
├─ README.md         // 人类可读文档
├─ README_AI.md      // LLM 可读文档
└─ src/              // Arduino 库源码
```

---

## 一、源码分析

### 1.1 API 识别

分析头文件，识别公共 API，按操作类型分类：

| 操作类型 | 说明 | 示例 |
|---------|------|------|
| 初始化 | 对象创建、基本配置 | `PubSubClient(client)`, `setServer()` |
| 连接 | 网络连接、认证 | `connect(clientId, user, pass)` |
| 通信 | 发送、接收、订阅 | `publish()`, `subscribe()` |
| 状态 | 连接检查、错误状态 | `connected()`, `state()` |
| 维护 | 保持连接、清理资源 | `loop()` |
| 快捷操作 | 一个块完成完整工作流 | 文件读写、数据传输 |

### 1.2 用户流程设计

```
设备初始化 → 网络连接 → 服务配置 → 数据交换 → 状态监控
                                         ↓
                                    快捷操作模式
                                   (简化工作流)
```

---

## 二、block.json 设计规范

### 2.1 块类型映射规则

| Arduino 模式 | 块类型 | 连接方式 | 字段类型 | 设计要点 |
|-------------|--------|----------|----------|---------|
| 对象创建/初始化 | Statement | previousStatement/nextStatement | `field_input` | 用户输入变量名，自动注册 |
| 全局对象方法调用 | Statement | previousStatement/nextStatement | 无变量字段 | 直接调用全局对象（Serial、httpUpdate 等） |
| 对象方法调用 | Statement | previousStatement/nextStatement | `field_variable` | 引用已创建的对象变量 |
| 全局对象状态查询 | Value | output: ["Type"] | 无变量字段 | 直接返回全局对象状态 |
| 快捷操作 | Statement/Value | 标准连接 | 无变量字段，直接参数 | 自动生成辅助函数 |
| 事件回调 | Hat 块 | 无 previousStatement/nextStatement | `field_variable` + `input_statement` | 帽子模式，事件驱动 |
| 条件回调 | 混合块 | 有 previousStatement/nextStatement | `input_value` + `input_statement` | 主程序流中定义条件回调 |
| 状态查询 | Value | output: ["Type"] | `field_variable` | 引用对象，返回值 |

### 2.2 field_input vs field_variable

**`field_input`：用于对象初始化**（用户输入新变量名）：
```json
{
  "type": "field_input",
  "name": "VAR",
  "text": "button1"
}
```

**`field_variable`：用于方法调用**（选择已有变量）：
```json
{
  "type": "field_variable",
  "name": "VAR",
  "variable": "button1",
  "variableTypes": ["OneButton"],
  "defaultType": "OneButton"
}
```

**generator.js 中读取变量名**：
- `field_input`：`block.getFieldValue('VAR')`
- `field_variable`：`const varField = block.getField('VAR'); const varName = varField ? varField.getText() : 'default';`
- 全局对象：直接使用对象名，如 `Serial`、`WiFi`

### 2.3 全局对象识别标准

- **平台内建**：`Serial`、`Wire`、`SPI`、`WiFi`、`httpUpdate`、`SPIFFS`、`ESP`、`EEPROM` 等
- **库全局实例**：头文件中已声明为全局实例的对象
- **单例对象**：设计为全局唯一访问的对象

全局对象块无需变量管理和重命名监听器。

### 2.4 标准块结构模板

**基本 Statement 块**（自定义对象）：
```json
{
  "type": "libname_funcname",
  "message0": "描述标签 %1 %2",
  "args0": [
    {
      "type": "field_variable",
      "name": "VAR",
      "variable": "defaultName",
      "variableTypes": ["CustomType"],
      "defaultType": "CustomType"
    },
    {"type": "input_value", "name": "PARAM", "check": ["Type"]}
  ],
  "previousStatement": null,
  "nextStatement": null,
  "colour": "#统一颜色",
  "tooltip": "块功能描述"
}
```

**全局对象调用块**（无变量字段）：
```json
{
  "type": "serial_println",
  "message0": "Serial %1 print %2 with newline",
  "args0": [
    {
      "type": "field_dropdown",
      "name": "SERIAL",
      "options": "${board.serialPort}"
    },
    {"type": "input_value", "name": "VAR"}
  ],
  "previousStatement": null,
  "nextStatement": null,
  "colour": "#48c2c4",
  "tooltip": "串口打印（换行）"
}
```

**全局对象状态查询块**（Value 输出，无参数）：
```json
{
  "type": "httpupdate_get_last_error",
  "message0": "get last update error code",
  "output": "Number",
  "colour": "#FF9800",
  "tooltip": "返回最后一次更新的错误码"
}
```

**事件回调块**（Hat 模式，无连接属性，返回空字符串）：
```json
{
  "type": "onebutton_attach_click",
  "message0": "when button %1 is clicked",
  "args0": [
    {
      "type": "field_variable",
      "name": "VAR",
      "variable": "button",
      "variableTypes": ["OneButton"],
      "defaultType": "OneButton"
    }
  ],
  "message1": "do %1",
  "args1": [{"type": "input_statement", "name": "HANDLER"}],
  "colour": "#5CB85C",
  "tooltip": "设置按钮单击事件处理器"
}
```

**混合块**（条件回调，有连接属性 + 回调体，返回条件代码）：
```json
{
  "type": "pubsub_set_callback_with_topic",
  "message0": "when topic %1 received do",
  "args0": [{"type": "input_value", "name": "TOPIC"}],
  "message1": "%1",
  "args1": [{"type": "input_statement", "name": "HANDLER"}],
  "previousStatement": null,
  "nextStatement": null,
  "colour": "#9C27B0",
  "tooltip": "处理特定 MQTT 主题"
}
```

---

## 三、generator.js 实现规范

### 3.1 核心库函数

直接调用，无需自行实现：
- `registerVariableToBlockly(varName, varType)` — 注册变量到 Blockly 系统
- `renameVariableInBlockly(block, oldName, newName, varType)` — 重命名变量

### 3.2 Generator 内置去重机制

以下方法均自动去重，直接调用即可：
- `generator.addLibrary(tag, code)` — 添加 `#include`
- `generator.addVariable(tag, code)` — 添加变量声明
- `generator.addFunction(tag, code)` — 添加函数定义
- `generator.addObject(tag, code)` — 添加全局对象/常量声明

### 3.3 变量重命名监听器（必须自行实现）

初始化块使用 `field_input` 时，需实现重命名监听器：

```javascript
// 在 generator 函数开头添加，仅在首次执行时绑定
if (!block._varMonitorAttached) {
  block._varMonitorAttached = true;
  block._varLastName = block.getFieldValue('VAR') || 'defaultVar';
  registerVariableToBlockly(block._varLastName, 'VariableType');
  const varField = block.getField('VAR');
  if (varField) {
    const originalFinishEditing = varField.onFinishEditing_;
    varField.onFinishEditing_ = function(newName) {
      if (typeof originalFinishEditing === 'function') {
        originalFinishEditing.call(this, newName);
      }
      const workspace = block.workspace || (typeof Blockly !== 'undefined' && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
      const oldName = block._varLastName;
      if (workspace && newName && newName !== oldName) {
        renameVariableInBlockly(block, oldName, newName, 'VariableType');
        block._varLastName = newName;
      }
    };
  }
}
```

### 3.4 Generator 实现模式

**自定义对象块**（含变量管理）：
```javascript
Arduino.forBlock['onebutton_setup'] = function(block, generator) {
  // 1. 变量重命名监听器（参见 3.3 节，此处省略）

  // 2. 提取参数
  const varName = block.getFieldValue('VAR') || 'button';
  const pin = block.getFieldValue('PIN');
  const activeLow = block.getFieldValue('ACTIVE_LOW') === 'TRUE';

  // 3. 库和变量管理（自动去重）
  generator.addLibrary('OneButton', '#include <OneButton.h>');
  registerVariableToBlockly(varName, 'OneButton');
  generator.addVariable('OneButton ' + varName, 'OneButton ' + varName + ';');

  // 4. 自动添加 tick() 到主循环（自动去重）
  generator.addLoopBegin(varName + '.tick();', varName + '.tick();');

  // 5. 生成代码
  return varName + '.setup(' + pin + ', INPUT_PULLUP, ' + activeLow + ');\n';
};
```

**全局对象块**（无变量管理，简化）：
```javascript
Arduino.forBlock['serial_println'] = function(block, generator) {
  const serialPort = block.getFieldValue('SERIAL') || 'Serial';
  const content = generator.valueToCode(block, 'VAR', generator.ORDER_ATOMIC) || '""';
  return serialPort + '.println(' + content + ');\n';
};

Arduino.forBlock['httpupdate_get_last_error'] = function(block, generator) {
  generator.addLibrary('ESP32httpUpdate', '#include <ESP32httpUpdate.h>');
  return ['httpUpdate.getLastError()', generator.ORDER_ATOMIC];
};
```

**事件回调块**（Hat 模式，返回空字符串）：
```javascript
Arduino.forBlock['onebutton_attach_click'] = function(block, generator) {
  const varField = block.getField('VAR');
  const varName = varField ? varField.getText() : 'button';
  const handlerCode = generator.statementToCode(block, 'HANDLER') || '';
  const callbackName = 'onebutton_click_' + varName;

  const functionDef = `void ${callbackName}() {\n${handlerCode}}\n`;
  generator.addFunction(callbackName, functionDef);

  let code = varName + '.attachClick(' + callbackName + ');\n';
  generator.addSetupEnd(code, code);
  generator.addLoopBegin(varName + '.tick();', varName + '.tick();');

  return ''; // Hat 块返回空字符串
};
```

**混合块**（条件回调，返回条件代码）：
```javascript
Arduino.forBlock['pubsub_set_callback_with_topic'] = function(block, generator) {
  const topic = generator.valueToCode(block, 'TOPIC', generator.ORDER_ATOMIC) || '""';
  const callbackName = 'mqtt' + topic.replace(/[^a-zA-Z0-9]/g, '_') + '_sub_callback';
  const callbackBody = generator.statementToCode(block, 'HANDLER') || '';

  const functionDef = 'void ' + callbackName + '(const char* payload) {\n' + callbackBody + '}\n';
  generator.addFunction(callbackName, functionDef);

  return 'if (strcmp(topic, ' + topic + ') == 0) {\n  ' + callbackName + '(payload_str);\n}\n';
};
```

**快捷操作块**（自动生成辅助函数）：
```javascript
Arduino.forBlock['esp32_sd_write_file_quick'] = function(block, generator) {
  const path = generator.valueToCode(block, 'PATH', generator.ORDER_ATOMIC) || '""';
  const content = generator.valueToCode(block, 'CONTENT', generator.ORDER_ATOMIC) || '""';

  generator.addLibrary('FS', '#include <FS.h>');
  generator.addLibrary('SD', '#include <SD.h>');

  let functionDef = '';
  functionDef += 'void writeFile(const char * path, const char * message) {\n';
  functionDef += '  File file = SD.open(path, FILE_WRITE);\n';
  functionDef += '  if (!file) { Serial.println("Failed to open file"); return; }\n';
  functionDef += '  file.print(message);\n';
  functionDef += '  file.close();\n';
  functionDef += '}\n';
  generator.addFunction('writeFile_function', functionDef, true);

  return 'writeFile(' + path + ', ' + content + ');\n';
};
```

### 3.5 智能开发板适配

```javascript
function ensureWiFiLib(generator) {
  const boardConfig = window['boardConfig'];
  if (boardConfig && boardConfig.core && boardConfig.core.indexOf('esp32') > -1) {
    generator.addLibrary('WiFi', '#include <WiFi.h>');
  } else if (boardConfig && boardConfig.core && boardConfig.core.indexOf('renesas_uno') > -1) {
    generator.addLibrary('WiFi', '#include <WiFiS3.h>');
  } else {
    generator.addLibrary('WiFi', '#include <WiFi.h>');
  }
}
```

---

## 四、toolbox.json 配置

**所有 `input_value` 插槽必须配置 shadow 块**：
```json
{
  "kind": "block",
  "type": "pubsub_publish",
  "inputs": {
    "TOPIC": {"shadow": {"type": "text", "fields": {"TEXT": "topic"}}}
  }
}
```

**按用户认知流程组织**：
```json
{
  "kind": "category",
  "name": "MQTT",
  "contents": [
    {"kind": "label", "text": "连接"},
    {"kind": "block", "type": "mqtt_create"},
    {"kind": "label", "text": "通信"},
    {"kind": "block", "type": "mqtt_publish"}
  ]
}
```

---

## 五、package.json 配置

```json
{
  "name": "@aily-project/lib-libname",
  "nickname": "显示名称",
  "description": "简洁描述（<50字符）",
  "version": "语义化版本",
  "compatibility": {
    "core": ["arduino:avr", "esp32:esp32", "esp8266:esp8266", "renesas_uno:unor4wifi"],
    "voltage": [3.3, 5]
  },
  "keywords": ["aily", "blockly", "功能关键词"],
  "tested": true,
  "url": "原始库 URL"
}
```

**开发板适配简写**：
- 通用库：`"core": []`（空数组 = 支持所有板）
- 仅 ESP32：`"core": ["esp32:esp32"]`
- 经典 Arduino：`"core": ["arduino:avr", "arduino:megaavr"]`
- IoT 板：`"core": ["esp32:esp32", "esp8266:esp8266", "renesas_uno:unor4wifi"]`

---

## 六、质量检查清单

- [ ] 覆盖原始库 80%+ 核心功能
- [ ] 新用户 10 分钟内上手
- [ ] 常见任务 ≤3 步完成
- [ ] 生成代码 100% 可编译
- [ ] 支持目标开发板
- [ ] 所有 `input_value` 都有 shadow 块
