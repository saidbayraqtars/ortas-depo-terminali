@echo off
rem Vega veritabaninin kucuk calisma kopyasini alir (firma + son donem).
rem SQL Server'in kurulu oldugu bilgisayarda cift tiklayin. Cikti: C:\VegaKopya\VEGAKOPYA_<firma>.zip
rem Veritabani ve firma tekse sorulmaz. OTOMATIK tanimliysa hic soru sorulmaz (SUNUCU, DB, KULLANICI, PAROLA, FIRMA, SINIR).
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem Paketlenirken musterinin sa parolasi yazilir; depoda bos kalir.
set "VARSAYILAN=__PAROLA__"
if "!VARSAYILAN!"=="__PAROLA__" set "VARSAYILAN="

set "SQ="
where sqlcmd >nul 2>&1 && set "SQ=sqlcmd"
if not defined SQ for /f "delims=" %%f in ('dir /s /b "%ProgramFiles%\Microsoft SQL Server\SQLCMD.EXE" 2^>nul') do if not defined SQ set "SQ=%%f"
if not defined SQ (
  echo sqlcmd bulunamadi. Bu dosyayi SQL Server'in kurulu oldugu bilgisayarda calistirin.
  goto :son_hata
)

if not defined SUNUCU set "SUNUCU=localhost"
if not defined KULLANICI set "KULLANICI=sa"
if not defined SINIR set "SINIR=2048"
if not defined PAROLA set "PAROLA=!VARSAYILAN!"

echo.
echo === Vega veritabani kopyasi ===
echo.
set "LISTE=%TEMP%\vegakopya_liste.txt"
set "DENEME=0"

:baglan
if "!PAROLA!"=="" (set AUTH=-E) else (set AUTH=-U "!KULLANICI!" -P "!PAROLA!")
"%SQ%" -S "!SUNUCU!" !AUTH! -C -d master -b -h -1 -W -f 65001 -i "%~dp0bul.sql" > "!LISTE!" 2>nul
if errorlevel 1 (
  if defined OTOMATIK (echo Baglanilamadi. & goto :son_hata)
  if !DENEME! geq 2 (echo Baglanilamadi. & goto :son_hata)
  set /a DENEME+=1
  echo !SUNUCU! sunucusuna baglanilamadi.
  set /p "SUNUCU=SQL sunucusu [!SUNUCU!]: "
  set /p "KULLANICI=Kullanici [!KULLANICI!]: "
  set "PAROLA="
  set /p "PAROLA=Parola: "
  goto :baglan
)

if not defined DB (
  set "N=0"
  for /f "usebackq delims=" %%d in ("!LISTE!") do (set /a N+=1 & set "DB=%%d")
  if !N! equ 0 (echo Sunucuda Vega veritabani bulunamadi. & goto :son_hata)
  if !N! gtr 1 (
    if defined OTOMATIK (echo Birden fazla Vega veritabani var; DB belirtin. & goto :son_hata)
    echo Vega veritabanlari:
    type "!LISTE!"
    set "DB="
    set /p "DB=Kopyalanacak veritabani adi: "
  )
)
echo Veritabani: !DB!

if not defined FIRMA (
  "%SQ%" -S "!SUNUCU!" !AUTH! -C -d "!DB!" -b -h -1 -W -s " " -f 65001 -Q "SET NOCOUNT ON; SELECT IND, KISAAD FROM TBLFIRMA ORDER BY IND" > "!LISTE!"
  if errorlevel 1 (echo Firmalar okunamadi. & goto :son_hata)
  set "N=0"
  for /f "usebackq tokens=1" %%f in ("!LISTE!") do (set /a N+=1 & set "FIRMA=%%f")
  if !N! gtr 1 (
    if defined OTOMATIK (echo Birden fazla firma var; FIRMA belirtin. & goto :son_hata)
    echo Firmalar:
    type "!LISTE!"
    set "FIRMA="
    set /p "FIRMA=Kopyalanacak firmanin IND numarasi: "
  )
)
if "!FIRMA!"=="" (echo Firma bulunamadi. & goto :son_hata)
echo Firma: !FIRMA!

set "KLASOR=C:\VegaKopya"
if not exist "%KLASOR%" mkdir "%KLASOR%"
rem SQL Server hizmeti yedegi bu klasore yazabilsin.
icacls "%KLASOR%" /grant *S-1-1-0:(OI)(CI)M >nul 2>&1
if exist "%KLASOR%\VEGAKOPYA.bak" del /q "%KLASOR%\VEGAKOPYA.bak"

echo.
echo Kopya aliniyor, bu birkac dakika surebilir...
"%SQ%" -S "!SUNUCU!" !AUTH! -C -d master -b -f 65001 -i "%~dp0kopya.sql" -v KAYNAK="!DB!" FIRMA=!FIRMA! SINIRMB=!SINIR! YEDEK="%KLASOR%\VEGAKOPYA.bak"
if errorlevel 1 (echo Kopya alinamadi. Yukaridaki hatayi Said'e iletin. & goto :son_hata)
if not exist "%KLASOR%\VEGAKOPYA.bak" (echo Yedek dosyasi olusmadi. SQL Server baska bir bilgisayardaysa bu dosyayi orada calistirin. & goto :son_hata)

echo.
echo Sikistiriliyor...
set "ZIP=%KLASOR%\VEGAKOPYA_!FIRMA!.zip"
if exist "!ZIP!" del /q "!ZIP!"
tar -a -c -f "!ZIP!" -C "%KLASOR%" VEGAKOPYA.bak 2>nul
if exist "!ZIP!" (del /q "%KLASOR%\VEGAKOPYA.bak" & set "SONUC=!ZIP!") else (set "SONUC=%KLASOR%\VEGAKOPYA.bak")

echo.
echo Bitti: !SONUC!
echo Bu dosyayi Said'e gonderin.
if not defined OTOMATIK (
  start "" explorer "%KLASOR%"
  pause
)
exit /b 0

:son_hata
echo.
if not defined OTOMATIK pause
exit /b 1
