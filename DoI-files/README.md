# DoI

DoI 是适用于 iPhone 主屏幕 PWA 和 Android 的情侣亲密日记，支持离线记录、月历、统计、双人同步和共享相册。

## 本地运行和部署

1. 将 `wrangler.example.jsonc` 复制为 `wrangler.jsonc`。部署时填入自己的 Cloudflare Pages 项目名、D1 数据库名和 ID。使用 Backblaze B2 相册时填写自己创建的桶名。
2. 在本地 `.dev.vars` 中设置随机生成的 `DOI_SETUP_KEY`。生产环境通过 Cloudflare Pages Secrets 设置 `DOI_SETUP_KEY`，使用 B2 相册时还需设置 `B2_KEY_ID` 和 `B2_APPLICATION_KEY`。
3. 按 [PWA 开发方案](PWA开发方案.md#本地运行) 运行本地预览或部署。`migrations/` 包含初始化 D1 表结构的脚本。

## Android

[Android 构建说明](android/README.md) 中的 `-PdoiHost` 参数用于指定应用加载的 HTTPS 站点域名。
