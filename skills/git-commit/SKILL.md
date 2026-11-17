---
name: git-commit
description: 生成规范、可追溯的 Git 提交。当用户说「提交一下」「写个 commit」「帮我 commit」时使用；会先看改动再起草信息，并在执行前确认。
---

# Git 提交

## 步骤

1. 看清改动范围（避免把无关文件一起提交）：

```bash
git status --short
git diff --stat
git diff --cached --stat
git log --oneline -10     # 参考仓库既有风格
```

2. 判断是否需要拆分成多次提交：一次提交只做一件事（功能 / 修复 / 重构 / 文档 分开）。

3. 起草提交信息，格式：

```
<type>(<scope>): <subject>

<body>          # 可选：为什么改，而不是改了什么
<footer>        # 可选：BREAKING CHANGE、Closes #123
```

- type：`feat` `fix` `refactor` `perf` `docs` `test` `chore` `build` `ci`
- subject：祈使句、不超过 50 字、结尾不加句号
- body：每行不超过 72 字

示例：

```
fix(auth): 修复 token 过期后未刷新导致的 401

刷新逻辑里漏了并发请求只触发一次 refresh 的判断，
多请求同时过期时会重复刷新。
```

## 执行前必须确认

提交会把改动写进历史，执行前先向用户展示：

- 将要提交的文件列表
- 起草好的提交信息

得到确认后再执行：

```bash
git add <具体文件>     # 不要用 git add . 一把梭
git commit -F - <<'EOF'
<提交信息>
EOF
```

## 规则

- 绝不擅自 `git push`、`git commit --amend`、`git reset --hard`、`--force`。
- 绝不把密钥、`.env`、大二进制文件提交进去；发现就提醒先加 `.gitignore`。
- 提交失败（pre-commit hook 报错）时，把原始错误贴出来，按提示修复后重新提交，不要用 `--no-verify` 绕过。
- 用英文 type + 中文 subject 是常见做法；跟随仓库既有风格。
