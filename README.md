# 按文档分夹（obsidian-doc-folder-oss）

**源码就在本机这一份，也是 GitHub 仓库根目录：**

```text
E:\00_code\99_self\obsidian-doc-folder-oss
```

仓库：https://github.com/xingzixhh/obsidian-doc-folder-oss

下面 `.obsidian/plugins/obsidian-doc-folder-oss/` 只是 Obsidian **装进去用** 的拷贝，改代码请改上面那个目录，再拷 `main.js` / `manifest.json` 进去。

Obsidian 桌面插件。在笔记里粘贴或拖入图片时：

1. 按**当前这篇**建 OSS 目录
2. 压缩（最长边 1920，尽量不超过 400KB）
3. 传到阿里云，插入 `![](https://...)`
4. 从这篇笔记里删掉该图链接后，约 1.5 秒再删 OSS 上对应文件（可在设置里关掉）

## 安装

1. 把整个文件夹拷到仓库的：

```text
{你的仓库}/.obsidian/plugins/obsidian-doc-folder-oss/
```

写小麦帮助、且把 `content\1.docs` 当仓库时，就是：

```text
E:\00_code\99_self\9046_ai_matrix_electron_v3\9046_v3_ai_matrix_website\content\1.docs\.obsidian\plugins\obsidian-doc-folder-oss\
```

里面至少要有 `manifest.json` 和 `main.js`。

2. Obsidian → 设置 → 第三方插件 → 关闭安全模式 → 启用 **按文档分夹**
3. 填 AccessKey ID、Secret、Bucket（默认 `9046xiaomai-doc`）、地域 `oss-cn-beijing`

桶要 **公共读**，关掉 **阻止公共访问**。防盗链白名单加 `xm.jujiang.top` 和 `127.0.0.1`。

## 路径

默认（只用文件名）：

```text
docs/3.chrome-ruhe-daochu-cookie/202611071223000.jpg
```

打开「用仓库相对路径当分夹」时会带上中间目录，例如 `docs/80.question/3.xxx/`。

当前没有打开笔记时，进 `docs/未分类/`。

命令面板可搜「上传剪贴板图片」。只支持桌面版。密钥只存在本机 `data.json`，不要提交进 Git。

删链接只会动本桶、且在 OSS 前缀（默认 `docs/`）下的图。同一链接在文里还留着一份，不会删云端。剪下立刻粘贴一般赶在 1.5 秒内，不会误删。删完再撤销，云端已经没了，图会裂。RAM 策略需要带 `oss:DeleteObject`。

改完 `main.js` 后：把文件再拷进仓库的 plugins 目录，Obsidian 里关掉再打开本插件，或重启 Obsidian。
