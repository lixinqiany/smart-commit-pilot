# Smart Git Pilot 发版

## 首次授权

两个市场都支持 GitHub Actions 可信发布（OIDC）。GitHub 仓库的 Actions Secrets 和 Variables 可以留空。

1. 在微软发布者后台选择 `michael-yu`，打开 **Trusted Publishing → Create**。Policy name 可填 `Smart Git Pilot release`。[微软发布者后台](https://marketplace.visualstudio.com/manage/publishers/michael-yu)
2. 用 `michael-yu` 命名空间的所有者账号登录 Open VSX，打开 **Trusted Publishers**，选择命名空间 `michael-yu` 和扩展 `smart-commit-pilot`。[Open VSX 设置](https://open-vsx.org/user-settings/trusted-publishers)

在两个页面分别填写并保存以下内容。

| 字段 | 值 |
| --- | --- |
| Repository owner | `lixinqiany` |
| Repository | `smart-commit-pilot` |
| Workflow | `release.yml` |
| Environment | 留空 |

## 试装 VSIX

PR 和推送到 `main` 都会执行类型检查、Lint 和 VS Code 集成测试。要生成试装包，先把工作流合入 `main`，再打开 **Actions → CI → Run workflow**。默认打包所选分支，也可以在可选输入框里填分支名或标签名。[仓库 Actions](https://github.com/lixinqiany/smart-commit-pilot/actions)

运行成功后，在该次运行底部的 **Artifacts** 下载 `vsix` 并解压。在 VS Code 命令面板运行 **Extensions: Install from VSIX...**，选择解压出的 `.vsix` 文件。手动试装包可在配置市场授权之前生成。

## 发布一批改动

1. 在 `package.json` 中填写两个市场均未使用的新版本，更新 `CHANGELOG.md`，将改动合入 `main`。
2. 在本地切到 `main` 并同步，然后给该提交打标签并推送。下面的命令从插件清单读取版本号。

   ```sh
   git switch main
   git pull --ff-only
   tag="v$(node -p 'require("./package.json").version')"
   git tag "$tag"
   git push origin "$tag"
   ```

3. 打开 **Actions → Release** 查看进度。流水线先核对标签与清单版本，运行检查并打包一次，再将同一个 VSIX 分别发布到两个市场。若只有一个市场失败，修复授权等问题后点 **Re-run failed jobs**，只重试失败的发布任务。
