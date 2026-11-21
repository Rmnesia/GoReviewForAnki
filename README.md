# 围棋复盘 · SRS 卡片复习工具

把 KaTrain / KataGo 的分析数据（每手目差、最佳下一手、AI 后续变化）转成「问题手」卡片，用 Anki 式间隔重复来练；另有独立的「名局背谱」模块，可随时选一方复现整局落子。纯 JavaScript 单页应用 + 一个极小的本地 Node 服务，所有分析都在本机完成，不依赖云端。

<img width="2560" height="1440" alt="image" src="https://github.com/user-attachments/assets/1932bfce-2af0-4000-bbb7-cc92f20bac35" />

<img width="2560" height="1440" alt="image" src="https://github.com/user-attachments/assets/299f01b1-920b-44c5-bd3a-5edd224a5636" />

<img width="2560" height="1440" alt="image" src="https://github.com/user-attachments/assets/20015610-60cf-40e3-8c88-7c2ae19c0a9a" />

## 快速开始

项目地址：`E:\GoReviewForAnki`（git 仓库）。环境：Windows、Node.js 18+、Python 3（仅首次解包用）；另需本机装有 KaTrain（`KaTrain.exe` 与同目录的 `.bin.gz` 模型）。

```bash
cd E:\GoReviewForAnki
python tools/extract_engine.py     # 只需一次：从 KaTrain.exe 解包内嵌 KataGo 到 engine/
node tools/serve.js                # 浏览器打开 http://127.0.0.1:8000
```

1. 点「**AI 分析（网页端）**」→ 勾选棋谱（默认只勾一局）→「开始分析」→ 完成后自动载入结果。
2. 填「学习方 id」（按 `PB`/`PW` 判定执色），调整三阶段阈值，问题手列表即时刷新。
3. 点「开始复习」进入卡片练习；或点右上角「名局背谱」随时收录并背一局名局。

> 直接双击 `index.html`（`file://`）仍可手动「导入棋谱 / 导入文件夹 / 粘贴 SGF」，但**没有后端**，网页端分析与「载入分析结果」不可用。

**KaTrain 安装位置**：脚本会自动探测 `E:\Katrain`（原安装目录）、项目同级 `Katrain/`、项目上级目录；也可用环境变量 `KATRAIN_DIR` 指定目录、`KATRAIN_EXE` 指定 exe 全路径、`KATAGO_MODEL` 指定模型全路径。原始 SGF 优先读项目内 `sgf/`，没有时读 KaTrain 安装目录的 `sgf/`；也可用 `--input` 指定任意目录。`sgf/` 已在 `.gitignore` 中，私人对局不会误提交。

## 网页端 AI 分析

面板参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| visits | **100** | 每手引擎搜索量，越大越准也越慢；100 visits 约 1.7 局面/秒（RTX 5060） |
| 并发线程 | 6 | 引擎并行查询数，GPU 满载后再加无收益 |
| 只分析前 N 手 | 0（全部） | 快速验证用；产物为 `*.partN.sgf`，不会覆盖完整棋谱 |
| 强制重算 | 关 | 忽略已有缓存重新分析 |

分析中会显示进度条、速率、预计剩余时间与日志，可随时「停止」；已完成的局面写入 `cache/`，下次自动续传。产物写到 `sgfout/`，是带 `KT[...]` 与中文复盘注释的标准 SGF。缓存按 `棋谱 + 手数 + visits + 规则 + 贴目` 分键，改 visits 不会误用旧缓存。

后端接口（由 `tools/serve.js` 提供）：`/api/source-games`、`POST /api/analyze`、`/api/analyze/status`、`POST /api/analyze/stop`、`/api/generated`。

## 等价的命令行方式

```bash
node tools/analyze.js                        # 分析默认 sgf/ 目录全部棋谱（默认 100 visits）
node tools/analyze.js --only 1793162379      # 只跑文件名含该片段的一局
node tools/analyze.js --visits 200 --force   # 提精度并忽略缓存重算
node tools/analyze.js --limit 8 --dry-run    # 只看将要分析的局面数，不启动引擎
node tools/analyze.js --input D:\mygames     # 指定别的棋谱目录
```

参数：`--only`、`--visits`、`--threads`、`--limit`、`--force`、`--dry-run`、`--save-every`、`--komi`、`--rules`、`--no-comments`、`--input`、`--out`、`--model`。首次启动会做 OpenCL 调优（约 3 分钟），缓存在 `engine/KataGoData/`，之后启动约 15 秒。

## 卡片怎么练

- **预览跟练**：点左侧问题手进入右侧预览（蓝圈 = AI 正解，红叉 = 实战落点）。**直接点击棋盘**（或点「跟练 AI 三步」）即可开始跟练，按 AI 主变化依次点出我方三手，对手应手自动摆出；「自动演示三步」会逐步播放整段变化，「重置预览」回到静态视图。预览跟练**不计入评级、不影响 SRS 进度**。
- **悬浮确定落子**：鼠标移到棋盘上会高亮目标格子、显示 GTP 坐标和半透明棋子预览，确认后再点击落子；落在已有棋子的位置会显示红框。**点到已有棋子时棋盘直接拦截：不算错、不计次、不改进度**，并给出轻提示。练习、预览跟练、名局背谱三块棋盘均生效。
- **正式复习**：从问题手落子前的局面出发，点出正解第一手 → 系统按 AI 变化自动摆对手应手 → 继续点我方第 2、3 手。步数 1–5 可调。
- **点错不重置**：停在当前这一步继续试，只累计错误次数；三步全对后按累计错误次数自动评级（默认 0 / 1 / 2 / ≥3 → 简单 / 良好 / 困难 / 重来，阈值可调）。
- **SRS**：Anki 式四档间隔与 ease 调度，到期卡片重新入队；复习中随时「删除此卡」，删除后不再出现。数据存浏览器 `localStorage`，支持 JSON 备份导出/导入。

## 名局背谱（与 SRS 完全独立）

**不需要任何 AI 分析数据** —— 只要 SGF 里有落子序列就能背，野狐导出的原始棋谱也行。

- **收录**：左侧「名局背谱」→ 从已导入棋谱点「☆ 收录选中棋谱」，或点「从 .sgf 文件收录」直接选 SGF 文件（可多选，无需先导入）。名局单独存一份精简落子序列，**清空已导入棋谱、改筛选阈值都不会影响它**；列表里可直接改名称、写备注、删除或清除进度。右上角「名局背谱」按钮可一键跳到该卡片。
- **开始**：设好「我背的一方」（黑 / 白）、起手与止手（止手填 `0` = 背到终局），点该局的「开始背谱」。系统按原谱**自动摆出对手的每一手**，你只需依次点出所选方的落子，与原谱坐标一致才通过。区间之前与区间之内对手的手都会自动摆好，所以可以从任意一手开始（例如只背 1–50 手布局）。
- **提示与点错**：点错**停在当前手**继续试，不重来；「提示」只在棋盘标出这一手的落点，仍需自己点。提示与点错分别计数，**不评级、不进 SRS**。原谱该手为虚着时点「本手 Pass」。悬浮确定落子格同样生效。
- **进度**：进度自动存入 `localStorage`，下次可「继续背（第 N 手）」或「从头背」；背完给出小结（我方手数、点错次数、提示次数）。名局与进度都包含在「导出备份」的 JSON 里。

## 筛选设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 学习方 id | 空 | 匹配 `PB`/`PW`，文件名 `[A]vs[B]` 兜底；改 id 自动重算 |
| 开局 / 中盘边界 | 50 / 150 手 | 开局 ≤50、中盘 51–150、官子 ≥151 |
| 三阶段目差阈值 | 2 / 5 / 3 目 | 严格大于阈值才算问题手，改动立即刷新 |
| 合并「连续同一步」 | 开 | 相邻问题手指向同一处错误时只保留第一次出现的那一手 |
| AI 预测步数 | 3 | 卡片要求我方连下的手数 |
| 评级阈值 | 0 / 1 / 2 | 累计错误次数，超过「困难」即「重来」 |

## 棋谱数据格式

- 优先读 KaTrain 的 `KT[a][b][c]`（三段 gzip+base64，第三段是含 `moves`/`root` 的分析 JSON），用 KaTrain 的公式算目差：`sign(color) × (父节点 scoreLead − 本节点 scoreLead)`，正解取父节点 `order=0` 候选的 `move` 与 `pv`。
- 没有 `KT` 时回退解析中文复盘注释「目数损失 / 推荐最佳选点 / PV」，同时兼容 `PV: BC14 D13 …` 与 `PV: B C14 …` 两种写法。
- 野狐导出的 `KM[375]` 表示 3.75 子，按 **7.5 目** 处理；规则默认中国规则。
- 用 KaTrain GUI 导出时必须勾选「分析缓存到SGF」才有 `KT`；否则只会有大于约 1.5 目失误的注释，阈值调低时数据不全，建议用本工具的网页端/命令行分析。

## 目录结构

```
GoReviewForAnki/
├─ index.html · css/style.css        页面与样式
├─ js/
│  ├─ sgf.js                        SGF 解析、KT 解压、注释回退、坐标换算
│  ├─ board.js                      19 路棋盘、提子、Canvas 渲染、悬浮落子、占用点拦截
│  ├─ review.js                     问题手筛选、连续合并、三步序列构造
│  ├─ srs.js                       Anki 式间隔调度
│  ├─ store.js                     localStorage 持久化、名局库/背谱进度、备份
│  └─ app.js                       UI 交互、复习流程、网页端分析、预览跟练、名局背谱
├─ tools/
│  ├─ extract_engine.py             从 KaTrain.exe 解包 KataGo
│  ├─ analyze.js                   批量分析（CLI 入口，同时被 serve.js 复用）
│  ├─ serve.js                     静态服务 + 分析 API
│  ├─ make_sample.js               生成演示 SGF
│  ├─ selftest.js                  逻辑自测
│  └─ browser_check.js             Chrome CDP 端到端测试
├─ sample/                         演示棋谱（分析数值为模拟）
├─ sgf/                            本地原始棋谱（gitignore，可用 --input 改）
├─ engine/                         解包出的 KataGo（gitignore）
├─ cache/ · sgfout/                分析缓存与产物（gitignore）
├─ LICENSE
└─ .gitignore
```

## 可选自检

```bash
node tools/selftest.js         # 纯逻辑，解析 / 摆谱 / 筛选 / SRS 全链路
node tools/browser_check.js    # headless Chrome 端到端（会真实跑一小段引擎分析）
```

## 说明

- 棋谱、分析、复习进度、名局库与背谱进度全部留在本机；`localStorage` 绑定访问来源，固定用 `http://127.0.0.1:8000` 最稳定。
- 换浏览器或清缓存前，用右上角「导出备份」保存 JSON。
- `sgf/` 里的原始棋谱与 `sample/` 演示棋谱可随时替换；`sgfout/` 里的文件可安全删除后用同一参数重新生成。
- 本目录是 git 仓库；`engine/`、`cache/`、`sgfout/`、`sgf/`、`tools/shots/` 等生成物与个人数据已忽略，提交时只含源码与文档。
