@echo off
rem Fidonect debug APK build (Windows, no admin needed).
rem Requires: JDK 17 in %%LOCALAPPDATA%%\FidonectBuild\jdk,
rem   Android SDK in %%LOCALAPPDATA%%\Android\Sdk,
rem   Gradle in %%LOCALAPPDATA%%\FidonectBuild\gradle
setlocal
set "JD="
for /f "delims=" %%d in ('dir /b /ad "%LOCALAPPDATA%\FidonectBuild\jdk\jdk-*" 2^>nul') do set "JD=%LOCALAPPDATA%\FidonectBuild\jdk\%%d"
if not defined JD ( echo JDK 17 not found under %%LOCALAPPDATA%%\FidonectBuild\jdk & exit /b 1 )
set "JAVA_HOME=%JD%"
set "ANDROID_SDK_ROOT=%LOCALAPPDATA%\Android\Sdk"
set "GB="
for /f "delims=" %%d in ('dir /b /ad "%LOCALAPPDATA%\FidonectBuild\gradle\gradle-*" 2^>nul') do set "GB=%LOCALAPPDATA%\FidonectBuild\gradle\%%d"
if not defined GB ( echo Gradle not found under %%LOCALAPPDATA%%\FidonectBuild\gradle & exit /b 1 )
call "%GB%\bin\gradle.bat" -p "%~dp0android" assembleDebug || exit /b 1
if not exist "%~dp0dist" mkdir "%~dp0dist"
copy /y "%~dp0android\app\build\outputs\apk\debug\app-debug.apk" "%~dp0dist\fidonect-v1.0.0-debug.apk" || exit /b 1
echo Built: %~dp0dist\fidonect-v1.0.0-debug.apk
certutil -hashfile "%~dp0dist\fidonect-v1.0.0-debug.apk" SHA256
