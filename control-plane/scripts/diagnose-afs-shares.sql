-- Read-only diagnosis. Retry the existing create-share API to repair these rows.
-- Does not expose access keys or remove shared directories/memberships.
SELECT s.id, s.owner_workspace_id, s.name, s.afs_dir_id, s.created_at
FROM afs_shares AS s
LEFT JOIN afs_share_members AS m
  ON m.share_id = s.id AND m.workspace_id = s.owner_workspace_id
WHERE m.workspace_id IS NULL
ORDER BY s.created_at;
