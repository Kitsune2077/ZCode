/**
 * session-import 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { OpenCodeNativeImportedSessionSource } from "./opencodeNativeSessionTypes.js";
import type { SessionImportRunParams, SessionImportScanParams } from "./contract.js";
import { opencodeNativeSessionImportRepo } from "./opencodeNativeSessionImportRepo.js";
import { importOpenCodeNativeSessions } from "./opencodeNativeSessionImportService.js";

export async function exampleSessionImportScan(params: SessionImportScanParams) {
  return opencodeNativeSessionImportRepo.scanImportableSessions(params);
}

export async function exampleSessionImportRun(
  params: SessionImportRunParams<OpenCodeNativeImportedSessionSource>,
) {
  return importOpenCodeNativeSessions(params);
}
