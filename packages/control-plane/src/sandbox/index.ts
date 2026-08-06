/**
 * Sandbox module exports.
 *
 * Two unrelated things live in this directory since the in-sandbox agent was
 * removed:
 *
 * 1. The execution backend — `outpost`, the only one. It provisions nothing.
 * 2. The cloud provider REST clients (Modal, E2B, Daytona, Vercel,
 *    OpenComputer). These are RETAINED as the fleet-member provisioning
 *    capability: a future creator uses the *user's own* provider API key to
 *    stand up a machine that runs the same outpost worker and speaks the same
 *    protocol. They are deliberately not wired to any execution path, and
 *    nothing in the control plane constructs them today.
 */

// Fleet-member provisioning transports (see note above)
export {
  ModalClient,
  createModalClient,
  type CreateSandboxRequest,
  type CreateSandboxResponse,
} from "./client";
export {
  E2BRestClient,
  E2BNotFoundError,
  E2BConflictError,
  E2BApiError,
  createE2BRestClient,
  type E2BRestConfig,
  type E2BSandboxDetail,
  type E2BSandboxCreated,
  type E2BCreateSandboxParams,
} from "./e2b-rest-client";
export {
  DaytonaRestClient,
  DaytonaNotFoundError,
  DaytonaApiError,
  createDaytonaRestClient,
  type DaytonaRestConfig,
  type DaytonaSandboxResponse,
  type DaytonaCreateSandboxParams,
} from "./daytona-rest-client";
export {
  OpenComputerRestClient,
  OpenComputerNotFoundError,
  OpenComputerApiError,
  createOpenComputerRestClient,
  type OpenComputerRestConfig,
  type OpenComputerSandboxResponse,
  type OpenComputerCreateSandboxParams,
  type OpenComputerDeleteSandboxOptions,
} from "./opencomputer-rest-client";
export {
  VercelSandboxClient,
  VercelSandboxApiError,
  createVercelSandboxClient,
  type VercelSandboxClientConfig,
  type VercelCreateSandboxRequest,
  type VercelCreateSandboxResponse,
  type VercelSandboxRoute,
  type VercelSandboxSession,
} from "./providers/vercel/client";

// Execution backend contract
export {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SandboxErrorType,
} from "./provider";
export { resolveSandboxBackendName, type SandboxBackendName } from "./provider-name";
export { OutpostSandboxProvider, createOutpostProvider } from "./providers/outpost-provider";

// Lifecycle decisions
export {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateWarmDecision,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
  type CircuitBreakerDecision,
  type SandboxState,
  type SpawnConfig,
  type SpawnAction,
  type InactivityState,
  type InactivityConfig,
  type InactivityAction,
  type HeartbeatConfig,
  type HeartbeatHealth,
  type WarmState,
  type WarmAction,
} from "./lifecycle/decisions";

// Lifecycle manager
export {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
  type SandboxLifecycleConfig,
} from "./lifecycle/manager";
