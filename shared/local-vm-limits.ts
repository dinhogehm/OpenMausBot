/** Highest per-bot Local VM / pool seat count Settings offers. Each running desktop is capped at 4 GB and 2 CPUs,
 * and an idle one stops on its own, so the real ceiling is the container runtime's memory, not this number. */
export const MAX_LOCAL_VM_MAX_INSTANCES = 16;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;

/** The choices the per-bot / pool limit selector lists, 1 through the maximum. */
export const LOCAL_VM_MAX_INSTANCE_CHOICES: readonly number[] = Array.from(
  { length: MAX_LOCAL_VM_MAX_INSTANCES - MIN_LOCAL_VM_MAX_INSTANCES + 1 },
  (_, index) => MIN_LOCAL_VM_MAX_INSTANCES + index,
);
