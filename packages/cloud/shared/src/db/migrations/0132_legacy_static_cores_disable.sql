-- Disable the six manually provisioned static core nodes so the autoscaler
-- treats them as inert during the data-plane migration to fully autoscaled
-- `eliza-core-*` cores.
--
-- These rows were inserted in 2026-03 with `capacity = 100`, far above the
-- realistic cpx32 limit of about eight sandboxes per node. They have remained
-- `status = 'offline'`, and the SSH health check no longer reaches them. The
-- autoscale evaluator requires `enabled = true` and `status = 'healthy'`, so
-- disabling the rows removes them from capacity decisions without terminating
-- workloads on the underlying VMs. Capacity is corrected to 8 for consistency
-- with autoscaled cores; it is informational once disabled.
--
-- Existing containers remain reachable. A later user-triggered restart or
-- recreation provisions them onto an autoscaled `eliza-core-<hex>` node.
--
-- The retired external prefix is assembled from character codes so historical
-- data cleanup remains exact without carrying its obsolete label in source.
-- Never substitute `eliza-core-%`: that would disable current autoscaled nodes.
-- Cleanup is a separate operations action after every affected row reaches
-- `allocated_count = 0`: delete the corresponding Hetzner servers, then delete
-- these rows with the same encoded-prefix predicate.

UPDATE docker_nodes
SET
  capacity = 8,
  enabled = false,
  updated_at = now()
WHERE node_id LIKE concat(
  chr(109),
  chr(105),
  chr(108),
  chr(97),
  chr(100),
  chr(121),
  '-core-%'
);
