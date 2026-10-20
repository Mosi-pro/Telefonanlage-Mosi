// Gemeinsame Test-Umgebung (kein Datenbank-/Asterisk-Zugriff noetig)
process.env.DATABASE_URL = 'postgres://x:x@localhost/x';
process.env.APP_SECRET = 'test-secret-test-secret-test-secret';
process.env.AMI_SECRET = 'test-ami';
