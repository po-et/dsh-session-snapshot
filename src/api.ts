/** Programmatic API of dsh-session-snapshot. */
export { verify, SUPPORTED_FORMAT_VERSION, type VerifyResult, type VerifyStatus } from './verify.js'
export {
  resolveHome, encodeSegment, decodeSegment, projectKey, sessionArtifact, listSessions, snapshotDir,
  type SessionFile,
} from './locate.js'
export {
  listSnapshots, takeSnapshot, restoreSnapshot,
  type Snapshot, type TakeOptions, type TakeResult, type RestoreResult,
} from './snapshot.js'
