-- Vega veritabanının küçük çalışma kopyası.
-- Seçilen firmanın kart tabloları (F0xxxTBL*) + son dönemin tabloları (F0xxxDyyyyTBL*) + TBLFIRMA/TBLDONEM
-- SELECT INTO ile geçici VEGAKOPYA veritabanına alınır, yedeklenir, geçici veritabanı silinir.
-- Log, e-fatura gelen kutusu, fiş tarihçesi gibi şişkin tablolar ve sınırdan büyük tablolar atlanır.
-- sqlcmd değişkenleri: KAYNAK, FIRMA, SINIRMB, YEDEK
SET NOCOUNT ON;

DECLARE @kaynak sysname = N'$(KAYNAK)';
DECLARE @firma int = $(FIRMA);
DECLARE @sinir int = $(SINIRMB);
DECLARE @yedek nvarchar(400) = N'$(YEDEK)';
DECLARE @sql nvarchar(max);

IF DB_ID(@kaynak) IS NULL BEGIN RAISERROR('Kaynak veritabani bulunamadi', 16, 1); RETURN; END

DECLARE @donem int;
-- Son dönem yıla göre (IND sırası yılı izlemeyebilir: Ortaş'ta IND 14 = 2006).
SET @sql = N'SELECT TOP 1 @d = IND FROM ' + QUOTENAME(@kaynak) + N'.dbo.TBLDONEM WHERE FIND = @f ORDER BY DONEM DESC, IND DESC';
EXEC sp_executesql @sql, N'@d int OUTPUT, @f int', @d = @donem OUTPUT, @f = @firma;
IF @donem IS NULL BEGIN RAISERROR('Bu firmanin donemi yok', 16, 1); RETURN; END

DECLARE @fk sysname = N'F' + RIGHT(N'0000' + CAST(@firma AS nvarchar(10)), 4);
DECLARE @dk sysname = @fk + N'D' + RIGHT(N'0000' + CAST(@donem AS nvarchar(10)), 4);
PRINT N'Firma ' + CAST(@firma AS nvarchar(10)) + N', donem IND ' + CAST(@donem AS nvarchar(10)) + N' (' + @dk + N')';

IF DB_ID(N'VEGAKOPYA') IS NOT NULL
BEGIN
  ALTER DATABASE VEGAKOPYA SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE VEGAKOPYA;
END
CREATE DATABASE VEGAKOPYA;
ALTER DATABASE VEGAKOPYA SET RECOVERY SIMPLE;

-- Kaynaktaki tablolar ve boyutları
CREATE TABLE #t(ad sysname, mb int);
SET @sql = N'
  INSERT INTO #t(ad, mb)
  SELECT t.name, CAST(SUM(s.used_page_count) * 8 / 1024 AS int)
  FROM ' + QUOTENAME(@kaynak) + N'.sys.tables t
  JOIN ' + QUOTENAME(@kaynak) + N'.sys.dm_db_partition_stats s ON s.object_id = t.object_id
  WHERE t.name IN (N''TBLFIRMA'', N''TBLDONEM'')
     OR (t.name LIKE @fk + N''TBL%'')
     OR (t.name LIKE @dk + N''TBL%'')
  GROUP BY t.name';
EXEC sp_executesql @sql, N'@fk sysname, @dk sysname', @fk = @fk, @dk = @dk;

DECLARE @ad sysname, @mb int, @alinan int = 0, @atlanan int = 0;
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT ad, mb FROM #t ORDER BY ad;
OPEN c;
FETCH NEXT FROM c INTO @ad, @mb;
WHILE @@FETCH_STATUS = 0
BEGIN
  IF @mb > @sinir
     OR @ad LIKE N'%EFAINBOX%' OR @ad LIKE N'%EFAOUTBOX%' OR @ad LIKE N'%FISTARIHCESI%'
     OR @ad LIKE N'%TBLLOG%' OR @ad LIKE N'%SNAPSHOT%' OR @ad LIKE N'%RESIM%' OR @ad LIKE N'%DBSTORE%'
  BEGIN
    PRINT N'  atlandi: ' + @ad + N' (' + CAST(@mb AS nvarchar(10)) + N' MB)';
    SET @atlanan += 1;
  END
  ELSE
  BEGIN
    SET @sql = N'SELECT * INTO VEGAKOPYA.dbo.' + QUOTENAME(@ad) + N' FROM ' + QUOTENAME(@kaynak) + N'.dbo.' + QUOTENAME(@ad) + N' WITH (NOLOCK)';
    BEGIN TRY
      EXEC (@sql);
      SET @alinan += 1;
    END TRY
    BEGIN CATCH
      PRINT N'  HATA: ' + @ad + N' - ' + ERROR_MESSAGE();
    END CATCH
  END
  FETCH NEXT FROM c INTO @ad, @mb;
END
CLOSE c; DEALLOCATE c;
PRINT CAST(@alinan AS nvarchar(10)) + N' tablo alindi, ' + CAST(@atlanan AS nvarchar(10)) + N' tablo atlandi.';

BACKUP DATABASE VEGAKOPYA TO DISK = @yedek WITH INIT, COPY_ONLY, STATS = 25;

ALTER DATABASE VEGAKOPYA SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
DROP DATABASE VEGAKOPYA;
PRINT N'TAMAM';
