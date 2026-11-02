# SaveHub Logo

标志以 **S 形存档轨迹 + 保存节点** 为核心：连续的 S 形代表可回溯的游戏进度，右上方的薄荷绿圆点代表保存下来的一个时刻。圆角方形适合作为桌面应用图标。

品牌色：深青 `#234C50 → #102A34`、浅色轨迹 `#F2F5EB`、薄荷绿节点 `#A8E5BB`。四种应用主题使用相同配色与图形。

| 文件 | 用途 |
| --- | --- |
| `icon.svg` | 唯一设计源文件；应用内 Logo 和浏览器标签图标直接使用 |
| `icon.png` | 1024 × 1024、透明边角，用于 macOS 打包输入及非 Windows 窗口图标 |
| `icon.ico` | Windows 窗口与打包图标，包含 16、24、32、48、64、128、256 像素图层 |

修改 SVG 后，在项目根目录运行：

```sh
pnpm build:icons
pnpm build
```

`build:icons` 使用项目已有的 Electron 在隐藏窗口内渲染，不依赖额外图像工具或网络服务。它会检查图像尺寸及透明边角，再更新 PNG 和 ICO；预览保存在 `docs/screenshots/savehub-logo.png`。图标源文件和生成的 PNG、ICO 均随源码提交，预览和临时渲染资料不提交。

更新这些资源不会改写已发布的 EXE。下次打包时，Windows 使用 ICO，macOS 由 electron-builder 根据 PNG 生成应用图标。
