-- Sunucudaki Vega veritabanlarını listeler (TBLFIRMA tablosu olanlar).
SET NOCOUNT ON;
DECLARE @s nvarchar(max) = N'';
SELECT @s = @s + N'IF OBJECT_ID(N''' + REPLACE(QUOTENAME(name), N'''', N'''''') + N'.dbo.TBLFIRMA'') IS NOT NULL PRINT N''' + REPLACE(name, N'''', N'''''') + N''';'
FROM sys.databases
WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 AND name <> N'VEGAKOPYA';
EXEC (@s);
