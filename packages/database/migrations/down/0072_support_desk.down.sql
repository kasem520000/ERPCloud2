-- تراجع P-C8: الجداول الثلاثة تسقط، وسياساتها معها.
DROP TABLE IF EXISTS support_sessions;
DROP TABLE IF EXISTS ticket_messages;
DROP TABLE IF EXISTS support_tickets;

DELETE FROM permissions WHERE code = 'console.support.manage';
