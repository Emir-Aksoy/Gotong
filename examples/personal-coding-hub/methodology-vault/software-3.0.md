# Software 3.0 —— 规范即程序

> 源:[[raw/sources]] · 上级:[[index]]

## 核心

Karpathy 把软件分三代:

| 代 | 你写的东西 | 例子 |
|---|---|---|
| **1.0** | 手写代码(给 CPU 的指令) | `for` 循环、函数 |
| **2.0** | 数据 + 训练出的**权重**(给优化器的目标) | 神经网络 |
| **3.0** | **自然语言 prompt / 规范**(给 LLM 的程序) | system prompt、`AGENTS.md` |

要点:**LLM 是一种新计算机,用英文编程**。于是「写清楚的规范」不再是文档,而是
**程序本身**。

## 对编码 agent 的含义

- **markdown 是 AI 时代的源代码**。`AGENTS.md` / `CLAUDE.md` / `program.md` /
  `llms.txt` 这类文件,是你给 agent 的「3.0 程序」—— 它们决定 agent 的行为,程度
  不亚于 1.0 代码决定 CPU。
- **像管代码一样管规范**:版本化、评审、保持单一事实源。规范漂移 = bug。
- **歧义是运行时错误**。English 比 Python 宽容,但 LLM 会照着模糊处自由发挥;把规范
  写得可执行(具体、有边界、有例子)。

## 落到本 hub

- `AGENTS.md` 就是那份「3.0 程序」,**两个 CLI 共享同一份字节**(同一个 `cwd`);
  真实里把 `CLAUDE.md` symlink 到 `AGENTS.md`,一份规范喂两个 agent。
- mentor 在派活前,应把目标对齐到 `AGENTS.md` 的约束;细节见 [[coding-with-agents]]。

→ 接着读:[[agentic-engineering]](怎么让 agent 安全地执行这份规范)。
