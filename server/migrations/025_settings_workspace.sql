UPDATE modules
SET name='Settings - Notifications', route='/settings/notifications'
WHERE id='notifications';

UPDATE modules
SET name='Settings - User Management', route='/settings/user-management'
WHERE id='permissions';

UPDATE modules
SET name='Settings - Price History', route='/settings/price-history'
WHERE id='price_history';

UPDATE modules
SET name='Settings - Backups', route='/settings/backups'
WHERE id='backups';

UPDATE modules
SET name='Settings - Offline Sync', route='/settings/offline-sync'
WHERE id='sync_monitor';

UPDATE users
SET default_landing = CASE default_landing
  WHEN '/notifications' THEN '/settings/notifications'
  WHEN '/staff' THEN '/settings/user-management'
  WHEN '/price-history' THEN '/settings/price-history'
  WHEN '/backups' THEN '/settings/backups'
  WHEN '/sync-monitor' THEN '/settings/offline-sync'
  ELSE default_landing
END
WHERE default_landing IN ('/notifications', '/staff', '/price-history', '/backups', '/sync-monitor');
