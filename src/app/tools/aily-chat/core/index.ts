/**
 * Aily Tool System - Core exports
 */

export type { IAilyTool, ToolContext, ToolSchema, ToolUseResult, ToolExecutionCallbacks } from './tool-types';
export { ToolRegistry } from './tool-registry';

// 宿主环境接口
export type {
  IAilyHostAPI,
  IFileSystem, IFileStat, IDirent,
  IPathUtils,
  ITerminal,
  IDialog, IDialogResult,
  IPlatform,
  IProjectProvider,
  IAuthProvider,
  IConfigProvider,
  IBuildProvider,
  INotificationProvider,
  IEnvProvider,
  IShellUtils,
  IEditorProvider, IConnectionGraphProvider,
  IMcpProvider, IMcpToolDef,
} from './host-api';
export { AILY_HOST_TOKEN } from './host-api-token';
