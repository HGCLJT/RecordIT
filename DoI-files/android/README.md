
# DoI 安卓版

Android 8.0 及以上。DoI 安装后从桌面图标打开，页面在应用内显示。首次打开需要联网，页面缓存完成后可离线打开本机月历。共享记录在恢复联网后同步。

## 情侣空间

构建时将安卓应用指向你的 DoI 网页部署，安卓与 iPhone 网页版即可使用同一个后端。同一个人的第二台设备在「设置 → 情侣空间」使用自己的设备恢复码，另一位伴侣首次加入时使用邀请码。本机记录仍保存在各自的应用中，可用 JSON 备份迁移。

安卓的 JSON 导出和恢复使用系统文件选择器，单个备份上限为 10 MB。JSON 文件包含原始记录内容。

从 1.1.0 版开始，「相册」可以调用安卓系统文件选择器上传图片和视频。相册需要完成配对并联网。

## 构建与安装

准备 JDK 17 或更新版本、Android SDK Platform 36 和 Build Tools 35.0.0。使用 Android Studio 打开本目录，或者设置本目录的 `local.properties`（`sdk.dir` 指向本机 SDK）。

```powershell
.\gradlew.bat :app:assembleRelease -PdoiHost=YOUR_HOSTNAME
```

将 `YOUR_HOSTNAME` 替换为部署站点的域名，无需加协议、端口或路径。构建时未指定域名会使用示例域名 `doi.example.invalid`。

构建会生成 `app/build/outputs/apk/release/app-release-unsigned.apk`。正式包用 Android SDK 的 `apksigner` 签名并运行 `apksigner verify --verbose` 校验。通过 APK 安装时，若手机显示系统提示，允许当前文件管理器安装此应用即可。

当前应用 ID 为 `dev.pages.doicouple`。覆盖升级时保持应用 ID 和签名一致，并递增 `versionCode`。使用自己的签名密钥发布 APK，并将密钥和密码保存在仓库外。
