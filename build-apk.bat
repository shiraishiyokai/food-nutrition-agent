@echo off
REM 食聊 Android 一键构建（依赖便携工具链，无需全局环境）
REM JDK 21（Capacitor 8 要求）在 food-nutrition-agent\toolchain，SDK/Gradle 缓存复用 WoS_AI 便携工具链
set JAVA_HOME=D:\my-project\food-nutrition-agent\toolchain\jdk-21.0.12.1+1
set GRADLE_USER_HOME=D:\my-project\WoS_AI\toolchain\gradle-home
set ANDROID_USER_HOME=D:\my-project\WoS_AI\toolchain\android-user
cd /d D:\my-project\food-nutrition-agent\app\android
call gradlew.bat assembleDebug
echo.
echo APK 输出: D:\my-project\food-nutrition-agent\app\android\app\build\outputs\apk\debug\app-debug.apk
pause
