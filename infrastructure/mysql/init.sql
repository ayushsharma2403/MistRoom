-- MistRoom MySQL Initialization
-- This runs once when the MySQL container is first created.

SET NAMES utf8mb4;
ALTER DATABASE mistroom CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Grant full privileges to the app user
GRANT ALL PRIVILEGES ON mistroom.* TO 'mistroom'@'%';
FLUSH PRIVILEGES;
