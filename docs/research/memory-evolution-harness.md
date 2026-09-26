# Graph Memory, Compounding Experience and Self-Evolution for an Automated Prediction-Market Trading Harness

State of the art as of 2026-09-26, with emphasis on 2025–2026 results.

**How to read this.** Each claim carries a verification tag:
- **[P]**: I read it in the primary source (the arXiv PDF text, the official blog or docs, or the GitHub file). Numbers were copied from tables in the source.
- **[S]**: it comes from a secondary source, such as a blog summarising a paper or tweet I could not fetch. Treat it as probably right but unverified.
- **[V]**: a vendor claim that nobody has checked independently.
- **[A]**: my own analysis or recommendation, not a published result.

---

## 0. Executive summary

1. **Graph memory helps multi-hop and temporal questions. It does not help single-hop detail lookups, and GraphRAG-style systems can cost 10–300× more tokens.** The best cost-quality point in the literature is HippoRAG 2. It uses Personalized PageRank (PPR) over a phrase+passage graph, costs about 1k tokens per query, and indexes with about 12× fewer LLM tokens than MS-GraphRAG (9.2M vs 115.5M input tokens on MuSiQue). For facts that change over time, Zep/Graphiti's bi-temporal edges with invalidation (never deletion) are the right way to store them. Vanilla dense RAG with a reranker still wins on single-hop, detail-oriented queries. [P]
2. **What compounds is abstract, verified and itemised knowledge**: playbook bullets with helpful/harmful counters, insight lists with votes, executable skills, and evaluator infrastructure. Raw trajectories and monolithic prompts rewritten each round do not compound reliably. Raw traces cause negative transfer, and monolithic rewrites cause "context collapse". **Every context-adaptation method degrades when feedback is unreliable.** This matters most for prediction markets, where outcomes are delayed and noisy. [P]
3. **Evolution loops must use Pareto or novelty-aware parent selection, not greedy hill-climbing**, and staged acceptance tests on data the mutator cannot see. The literature documents objective hacking (Darwin Gödel Machine, DGM), overfitting to the validation set, and misevolution. [P]
4. **Debate is mostly voting in disguise.** Majority voting or averaging accounts for most of the gains of multi-agent debate. In forecasting, the strongest recipe is K independent agentic runs, then a mean, then a supervisor that searches only to resolve disagreements, then log-odds extremization (α≈√3), then a blend with the market price. [P]
5. **Cascades save 40–98% of cost at matched quality.** They work only if the quality estimator is good; ensemble agreement is the most robust estimator available. [P]
6. **Harness rules from Anthropic, 2024–2026**: prefer the simplest pattern that works, use orchestrator-workers for breadth, and keep generation and evaluation in separate agents. Store state in files and git with context resets or handoffs, treat memory as a hint that must be verified, and remove scaffolding whenever the model improves. [P]

---

## 1. Graph memory for agents

### 1.1 HippoRAG and HippoRAG 2 (PPR over an open knowledge graph)

**Citations**
- Gutiérrez, Shu, Gu, Yasunaga, Su. *HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs*. NeurIPS 2024. arXiv:2405.14831.
- Gutiérrez, Shu, Qi, Zhou, Su. *From RAG to Memory: Non-Parametric Continual Learning for Large Language Models*. ICML 2025. arXiv:2502.14802. https://arxiv.org/abs/2502.14802
- Code: https://github.com/OSU-NLP-Group/HippoRAG

**Mechanism (HippoRAG 2)** [P]
- **Offline indexing**
  1. An LLM runs OpenIE over each passage and produces schema-less triples. Subjects and objects become *phrase nodes*, joined by *relation edges*.
  2. The retrieval encoder adds *synonym edges* between phrase pairs whose embedding similarity is at least a threshold.
  3. Each passage becomes a *passage node*, linked by "contains" *context edges* to every phrase extracted from it. This is the dense-sparse integration.
- **Online retrieval**
  1. **Query-to-triple linking**: the whole query is embedded and matched to triples, rather than extracting named entities (NER) and matching them to nodes.
  2. **Recognition memory**: the top-5 retrieved triples are filtered by an LLM. The filter prompt was tuned with DSPy MIPROv2.
  3. **Seeding**: at most **5 phrase nodes** become seeds, each scored by the average score of the filtered triples it appears in. **All passage nodes are also seeds**, because broader activation helps multi-hop recall. Passage reset probabilities are embedding similarity × a **weight factor of 0.05**. If the filter returns no triples, the system falls back to plain dense retrieval.
  4. PPR runs in python-igraph. Passages are ranked by their PageRank score and the top-5 go to the reader.

**Hyperparameters** (Table 13, tuned on 100 MuSiQue training examples) [P]

| Hyperparameter | Value |
|---|---|
| Synonym threshold | 0.8 |
| PPR damping factor | 0.5 |
| Temperature | 0 |
| Passage-node weight factor | 0.05 |
| Triples kept for filtering | top-5 |
| Max phrase seeds | 5 |
| QA context | top-5 passages |
| Extraction and filter model | Llama-3.3-70B-Instruct |
| Retriever | NV-Embed-v2 |

igraph's damping is the probability of continuing the walk, so a value of 0.5 means a restart probability of 0.5.

**Weight-factor sweep** (Table 5, passage recall@5 on dev sets) [P]

| Weight | 0.01 | 0.05 | 0.1 | 0.3 | 0.5 |
|---|---|---|---|---|---|
| MuSiQue | 79.9 | **80.5** | 79.8 | 78.4 | 77.9 |
| NQ | 75.6 | **76.9** | 76.9 | 76.7 | 76.4 |

**Results** (Llama-3.3-70B reader, same extractor and retriever for all methods) [P]
- **QA F1 (average over 7 datasets)**:

  | Method | Average F1 |
  |---|---|
  | HippoRAG 2 | 59.8 |
  | NV-Embed-v2 (dense) | 57.0 |
  | GraphRAG | 49.6 |
  | RAPTOR | 48.8 |
  | HippoRAG | 53.1 |
  | LightRAG | 6.6* |

  *LightRAG's outputs largely failed the short-answer QA protocol, so treat its number as a protocol-mismatch artifact rather than a capability measure.
- Selected per-dataset F1, HippoRAG 2 vs NV-Embed-v2: MuSiQue 48.6 vs 45.7, 2Wiki 71.0 vs 61.5, LV-Eval 12.9 vs 9.8.
- **Passage recall@5 (average over 5 datasets)**: HippoRAG 2 78.2, NV-Embed-v2 73.4. The gains are +5.0 on MuSiQue (74.7) and +13.9 on 2Wiki (90.4). On PopQA, the original HippoRAG is best (53.8 vs 51.7).
- **Ablations** (recall@5, average over MuSiQue, 2Wiki and HotpotQA):

  | Configuration | Recall@5 |
  |---|---|
  | Full HippoRAG 2 | 87.1 |
  | NER-to-node linking | 74.6 |
  | Query-to-node linking | 59.6 |
  | No passage nodes | 81.0 |
  | No filter | 86.4 |

  Query-to-triple linking adds +12.5 recall@5 over NER-to-node.
- **Continual learning**: when the corpus grows in quarters, HippoRAG 2 keeps its F1 lead over NV-Embed-v2 (Figure 3).

**Cost** (Table 12, MuSiQue corpus of 11,656 passages) [P]

| Method | Index input tokens | Index output tokens | Index time (min) | QA time per query | QA GPU memory |
|---|---|---|---|---|---|
| NV-Embed-v2 | – | – | 12.1 | 0.3 s | 1.7 GB |
| RAPTOR | 1.7M | 0.2M | 100.5 | 0.6 s | 1.4 GB |
| LightRAG | 68.5M | 18.3M | 235.0 | 13.3 s | 4.5 GB |
| GraphRAG | 115.5M | 36.1M | 277.0 | 10.7 s | 3.7 GB |
| HippoRAG | 9.2M | 3.0M | 57.5 | 0.9 s | 6.0 GB |
| **HippoRAG 2** | **9.2M** | **3.0M** | **99.5** | **1.2 s** | 9.9 GB |

**Graph size** (Table 10) [P]: synonym edges dominate. For MuSiQue there are about 1.13M synonym edges against 141k extracted edges and 133k context edges. Keep this in mind when sizing storage for the synonym threshold of 0.8.

### 1.2 Zep / Graphiti (temporal knowledge graph)

**Citation**: Rasmussen, Paliychuk, Beauvais, Ryan, Chalef. *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*. arXiv:2501.13956 (Jan 2025). https://arxiv.org/abs/2501.13956. Graphiti is open source: https://github.com/getzep/graphiti

**Graph structure** [P]
- The graph has three tiers:
  - an *episodic* subgraph of raw messages, text or JSON, each with a reference time t_ref;
  - a *semantic entity* subgraph of entities and fact edges;
  - a *community* subgraph.
- Episodes and facts keep bidirectional indices, so every fact can be traced to its source for citation.

**Entity extraction** [P]
- Each extraction sees the current message plus the **last n = 4 messages** (two full turns).
- A Reflexion-style reflection pass reduces hallucination.
- Entity names are embedded in **1024 dimensions**. Resolution candidates come from cosine search plus full-text search, and an LLM entity-resolution prompt decides merges.
- Writes use **predefined Cypher queries rather than LLM-generated queries**, to avoid schema hallucination.

**Facts** [P]
- A fact is an edge carrying the fact text and a key predicate.
- The same fact can connect several entity pairs, which gives hyper-edges.
- Deduplication searches **only edges between the same entity pair**. This avoids false merges and reduces cost.

**Bi-temporal model** [P]
- **Event timeline T** stores t_valid and t_invalid on each edge.
- **Transaction timeline T′** stores t′_created and t′_expired.
- Relative dates such as "two weeks ago" are resolved against t_ref.
- An LLM compares each new edge with semantically related existing edges. For temporally overlapping contradictions, **it sets the old edge's t_invalid to the new edge's t_valid**. The old edge is kept, and newer information wins on the T′ ordering.

**Communities** [P]
- Communities use **label propagation instead of Leiden**. When a node arrives, it joins the plurality community of its neighbours, which is one recursive step of label propagation.
- Community summaries are refreshed periodically, because these incremental assignments drift from what a full label-propagation run would give.

**Retrieval pipeline f(α) = χ(ρ(φ(α)))** [P]
- **Search (φ)**: cosine similarity, BM25 full-text, and **breadth-first search within n hops**. BFS can be seeded from recent episodes.
- **Rerank (ρ)**: RRF, MMR, an episode-mentions reranker that favours frequently mentioned items, a node-distance reranker around a centroid node, or a cross-encoder (most expensive).
- **Construct (χ)**: returns facts with their validity window, in the format `FACT (Date range: from - to)`, plus entity summaries.

**Results** [P]
- **Deep Memory Retrieval (DMR)**: 94.8% with gpt-4-turbo vs MemGPT's 93.4%; 98.2% with gpt-4o-mini.
- **LongMemEval_s**:

  | System | Score | Latency | Context tokens |
  |---|---|---|---|
  | Full-context, gpt-4o | 60.2% | 28.9 s | 115k |
  | Zep, gpt-4o | 71.2% | 2.58 s | 1.6k |
  | Full-context, gpt-4o-mini | 55.4% | – | – |
  | Zep, gpt-4o-mini | 63.8% | 3.20 s | – |

- **By question type, gpt-4o**:
  - temporal reasoning: 45.1 → 62.4 (+38.4% relative)
  - multi-session: 44.3 → 57.9
  - knowledge-update: 78.2 → 83.3
  - **single-session-assistant: 94.6 → 80.4 (−17.7%)**. Graph extraction loses verbatim detail.

### 1.3 Mem0 and Mem0g (graph variant)

**Citation**: Chhikara, Khant, Aryan, Singh, Yadav. *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*. arXiv:2504.19413 (Apr 2025). https://arxiv.org/abs/2504.19413

**Mechanism** [P]
- **Extraction** runs on each new message pair. It sees an asynchronously refreshed conversation summary S and the last **m = 10** messages.
- **Update**: for each candidate fact, the system retrieves the top **s = 10** similar memories. An LLM tool call then picks **ADD, UPDATE, DELETE or NOOP**.
- All operations use GPT-4o-mini.
- **Mem0g** stores a directed labelled graph in Neo4j:
  - nodes carry a type, an embedding and a creation timestamp; edges are triplets;
  - nodes are merged when similarity exceeds a threshold t;
  - an LLM "update resolver" **marks conflicting edges invalid instead of deleting them**, to keep temporal reasoning possible.
- Mem0g retrieval combines entity-centric graph expansion with semantic triplet matching.

**LoCoMo results** (LLM-as-judge J score, from Mem0's own runs) [P]

| Category | Mem0 | Mem0g | Zep (Mem0's run) | OpenAI memory | Other |
|---|---|---|---|---|---|
| Single-hop | 67.13 | 65.71 | 61.70 | – | – |
| Multi-hop | **51.15** | 47.19 | 41.35 | – | – |
| Open-domain | 72.93 | 75.71 | **76.60** | – | – |
| Temporal | 55.51 | **58.13** | 49.31 | 21.71 | LangMem 23.43 |
| **Overall** | 66.88 | 68.44 | 65.99 | – | Full-context **72.90** |

**Cost and latency** [P]

| System | Memory tokens | Total p95 latency | Search p95 latency |
|---|---|---|---|
| Mem0 | 1,764 | 1.44 s | 0.200 s |
| Mem0g | 3,616 | 2.59 s | – |
| Full-context | 26,031 | 17.1 s | – |

**The numbers are contested** [P] + [S]
- Zep's rebuttal says Mem0 misconfigured Zep: both speakers were given the user role, timestamps were appended to message text, and searches ran sequentially. Zep reports **75.14 ± 0.17 J** when configured correctly. It also notes that full-context beats Mem0 on LoCoMo, and that LoCoMo conversations of 16–26k tokens fit in context and contain no knowledge-update questions.
  - https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- A later GitHub issue on getzep/zep-papers (#5) disputes one of Zep's own LoCoMo claims ("84% → corrected 58.44%").
- A 2026 Mem0 blog claims 94.4% on LongMemEval [V].

**Lesson**: vendor memory numbers are not comparable across papers. Run your own evaluation.

### 1.4 A-MEM (Zettelkasten-style agentic memory)

**Citation**: Xu, Liang, Mei, Gao, Tan, Zhang. *A-Mem: Agentic Memory for LLM Agents*. arXiv:2502.12110 (v11, Oct 2025). Code: https://github.com/WujiangXu/A-mem-sys

**Mechanism** [P]
- **Atomic notes**: each note m_i holds the content c_i, a timestamp t_i, LLM-generated keywords K_i, tags G_i, a contextual description X_i, an embedding over concat(c, K, G, X), and a link set L_i.
- **Link generation**: find the top-k nearest notes by cosine (k = 10 in the main experiments). An LLM then decides which of them to link.
- **Memory evolution**: for each neighbour, an LLM may rewrite its context, keywords and tags in light of the new note.

**Results** [P]
- Ablation on LoCoMo with GPT-4o-mini, multi-hop F1: no link generation or evolution 9.65; links only 21.35; full system 27.02.
- About 1,200 tokens per memory operation, an 85–93% reduction compared with LoCoMo or MemGPT full context (16,900 tokens). Under $0.0003 per operation.
- **In Mem0's independent re-run, A-Mem scored an overall J of 48.38**, well below Mem0 and Zep.
- The papers label LoCoMo categories inconsistently, so compare per-category numbers across papers with care.

### 1.5 GraphRAG (Microsoft) vs LightRAG, and when graph retrieval helps at all

**Citations**
- Edge et al. *From Local to Global: A GraphRAG Approach to Query-Focused Summarization*. arXiv:2404.16130.
- Guo, Xia, Yu, Ao, Huang. *LightRAG: Simple and Fast Retrieval-Augmented Generation*. arXiv:2410.05779.

**GraphRAG** [P]
- Indexing:
  1. Entity and relation extraction over 600-token chunks, with "gleanings" as extra extraction passes.
  2. **Leiden** hierarchical communities (C0 at the root down to C3).
  3. Pre-generated community summaries.
- Global questions use map-reduce over the community summaries.
- On about 1M-token corpora, global methods beat vector RAG with **comprehensiveness win rates of 72–83%** and diversity win rates of 62–82%.
- Root-level (C0) summaries use **over 97% fewer tokens** than summarising the source text.

**LightRAG** [P]
- Graph indexing plus **dual-level keys**: low-level keys for entities and high-level keys for themes. The index updates incrementally.
- The paper claims retrieval uses **under 100 tokens** of keyword generation, against GraphRAG's roughly 610 communities × 1,000 tokens = 610k tokens.

**Independent comparisons** [P]
- **GraphRAG-Bench** (Xiang et al., ICLR 2026, arXiv:2506.05690), GPT-4o-mini on the Novel domain:

  | Task | Best method (accuracy) | Comparison |
  |---|---|---|
  | Fact retrieval | vanilla RAG + rerank (60.92) | MS-GraphRAG local 49.29 |
  | Complex reasoning | HippoRAG2 (53.38) | RAG + rerank 42.93 |

  Average prompt tokens per query:

  | Method | Tokens per query |
  |---|---|
  | Vanilla RAG | 879 |
  | HippoRAG2 | 1,008 |
  | LightRAG | ~100k |
  | MS-GraphRAG (global) | ~331k |

  The benchmark's takeaways: "prioritize precise retrieval", "build quality graphs, not just large ones", "actively manage context growth".
- **Han et al., RAG vs GraphRAG** (arXiv:2502.11371):
  - RAG wins on single-hop and detail queries; HippoRAG2 and community-GraphRAG (local) win on multi-hop.
  - Community-global search loses detail and **hallucinates on "insufficient information" (Null) queries**, but helps on Comparison and Temporal queries that need global information.
  - KG-only GraphRAG under-covers: **only about 65.8% of answer entities are in the extracted KG for HotpotQA, and 65.5% for NQ**.
  - Reranking and iterative retrieval (IRCoT) help both paradigms, most of all on multi-hop.

### 1.6 MemGPT/Letta, consolidation and sleep-time compute

**Citation**: Packer, Wooders, Lin, Fang, Patil, Stoica, Gonzalez. *MemGPT: Towards LLMs as Operating Systems*. arXiv:2310.08560.

**MemGPT** [P]
- Main context holds three parts: system instructions, **working context** (editable facts), and a **FIFO queue** whose first entry is a *recursive summary*.
- External context has two stores: **recall storage** (the full message history) and **archival storage** (a vector database).
- A queue manager sends a "memory pressure" warning at a *warning token count* of about **70% of the window**, so the agent can save important information.
- At the *flush token count* (**100%**), it evicts about **50% of the window** and regenerates the recursive summary.

**Sleep-time compute**: Lin, Snell, Wang, Packer, Wooders, Stoica, Gonzalez (Letta and UC Berkeley). arXiv:2504.13171 (Apr 2025). [P]
- Pre-computing over the context before the query arrives cuts **test-time compute by about 5× at equal accuracy** on Stateful GSM-Symbolic and Stateful AIME.
- Scaling sleep-time compute raises accuracy by up to **13% (GSM) and 18% (AIME)**.
- Amortising across **10 related queries per context cuts average cost per query by 2.5×**.
- The benefit correlates with how **predictable** the query is from the context.

**Letta sleep-time agents** (docs and blog) [P] + [S]
- A primary agent (fast model, no memory-editing tools) and a sleep-time agent (stronger model, e.g. Sonnet or GPT-4.1) share memory blocks. The sleep-time agent rewrites the primary's blocks from "raw context" into "learned context".
- The trigger fires every N steps. **The default of 5 steps is from search snippets and I could not confirm it on the current docs page [S].**
- Current Letta "dreaming" docs describe consolidation after a set number of steps or when the context is compacted, with an optional second-agent review before memory edits are applied [P].
- The sleep-time tools are `rethink_memory` (replace a block) and `finish_rethinking` [S/P, from the paper].

### 1.7 Memory in Claude Code and the Claude API (official) and "skeptical memory" (unofficial)

**Official** [P]
- **Claude Code docs** (https://code.claude.com/docs/en/memory):
  - Auto memory keeps `MEMORY.md` as an **index with one line per memory**. Only the **first 200 lines or 25KB are loaded** into each session, and details go into topic files.
  - When the index nears the limit, Claude Code tells Claude to "merge or drop stale entries".
  - Keep each CLAUDE.md **under 200 lines**. Memory is "context, not enforced configuration". Use hooks for hard constraints.
- **Claude API memory tool** (`memory_20250818`):
  - A client-side `/memories` directory with the commands view, create, str_replace, insert, delete and rename.
  - The API injects: "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE … ASSUME INTERRUPTION: Your context window might be reset at any moment".
  - The docs recommend path-traversal protection, file-size caps, and **periodic deletion of files not accessed in a long time**.
- **Anthropic context-management launch** (Sept 2025, https://claude.com/blog/context-management): memory tool plus context editing gave **+39%** on an internal agentic evaluation, context editing alone **+29%**, and an **84% token reduction** on a 100-turn web-search evaluation. [S, via search snippet of the official blog]

**Unofficial** [S]
- Analyses of Claude Code's leaked source (March 2026) describe:
  - "memory as a hint, not truth; verify before using";
  - freshness warnings on memories older than one day;
  - an `autoDream` consolidation subagent that runs after at least 24 hours and 5 sessions with file tools restricted to the memory directory.
- None of this is officially documented. Use it as design inspiration only.

### 1.8 Evidence from 2026: no single memory substrate wins

- **Huang et al., *Harness the Memory*** (arXiv:2608.15008, Aug 2026). Controlled comparison of dense and sparse indices, text records, structural (graph) stores, hierarchical stores, refinement memories, parametric updates and activation-level mechanisms, with 26 metrics. [P]
  - **No substrate dominates.** Broad retrieval helps long-context factual QA, but **too much retrieval hurts sequential decision-making** because it pulls attention away from action-critical context.
  - Substrates that do well at moderate history lengths become costly or brittle at longer horizons.
  - The authors recommend **routing between substrates**.
- **ExpWeaver** (Zhao et al., arXiv:2605.07164, May 2026). Making experience an optional resource the agent pulls in only at uncertain decision points beats injecting it once or at every step. Result held across 4 frameworks and 7 backbones. [P]
- **SAGE** (arXiv:2605.12061) and **NapMem** (arXiv:2607.05794) move toward learned memory writers and readers, and memory as an RL-trained action space. These are promising, but they require training. [P]

### 1.9 Which retrieval approach wins, and at what cost

| Query type | Winner | Evidence | Cost per query |
|---|---|---|---|
| Single-hop detail lookup | Dense retrieval + rerank | HippoRAG 2 NQ F1 is roughly a tie; GraphRAG-Bench fact retrieval 60.9 vs 49.3 for GraphRAG local; Han et al. 2025 | about 1k tokens, 0.3 s |
| Multi-hop, associative | **HippoRAG 2 (PPR)** | +13.9 recall@5 on 2Wiki, +5.0 on MuSiQue; best on complex reasoning in GraphRAG-Bench | about 1k tokens, 1.2 s; indexing 9.2M input + 3.0M output tokens for 11,656 passages |
| Temporal, "what is true now", knowledge updates | **Bi-temporal KG (Graphiti/Zep; Mem0g invalidation)** | LongMemEval temporal +38%; LoCoMo temporal J 58.1 (Mem0g) vs 55.5 (Mem0) | 1.6–3.6k tokens, 0.5–3 s |
| Global "themes" or sensemaking | GraphRAG community summaries (C0–C2) | 72–83% comprehensiveness win rate | 10k–330k prompt tokens; indexing ≈ 12.6× HippoRAG 2's input tokens |
| Anything, when history fits in context | Full context | LoCoMo J 72.9 (best), but 17 s p95 | 26k+ tokens per query |

---

## 2. Karpathy's "LLM Wiki" (April 2026) and "autoresearch" (March 2026)

### 2.1 LLM Wiki: sources and exact structure

**Sources**
- Tweet "LLM Knowledge Bases", 2 April 2026: https://x.com/karpathy/status/2039805659525644595 [S; x.com could not be fetched, date and text via VentureBeat and search snippets].
- The "idea file" gist `llm-wiki.md`, created 4 April 2026: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f [P; the raw file was read in full].

**Core idea** [P, quoted]: RAG means "the LLM is rediscovering knowledge from scratch on every question. There's no accumulation." Instead, "the LLM **incrementally builds and maintains a persistent wiki**", and "the wiki is a persistent, compounding artifact. The cross-references are already there. The contradictions have already been flagged." Karpathy's framing: "Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."

**Three layers** [P]
1. **Raw sources**: immutable. "the LLM reads from them but never modifies them. This is your source of truth."
2. **The wiki**: LLM-owned markdown (summaries, entity pages, concept pages, comparisons, an overview, a synthesis). "You read it; the LLM writes it."
3. **The schema**: CLAUDE.md or AGENTS.md describing structure, conventions and workflows. "You and the LLM co-evolve this over time."

**Operations** [P]
- **Ingest**: read the source → discuss the takeaways → write a summary page → update the index → update entity and concept pages → append to the log. "A single source might touch 10-15 wiki pages." Karpathy prefers one source at a time with a human in the loop. Batch ingest is possible.
- **Query**: read the index first → drill into pages → synthesise an answer with citations. The output can be markdown, a table, Marp slides, a matplotlib chart or a canvas. "**good answers can be filed back into the wiki as new pages**."
- **Lint** (periodic): check for "contradictions between pages, stale claims that newer sources have superseded, orphan pages with no inbound links, important concepts mentioned but lacking their own page, missing cross-references, data gaps that could be filled with a web search". The lint pass also suggests new questions and sources.

**Indexing and logging** [P]
- **index.md**: "content-oriented". Each page gets a link, a one-line summary and optional metadata (date, source count), grouped by category. Updated on every ingest and read first on every query. It "works surprisingly well at moderate scale (~100 sources, ~hundreds of pages) and avoids the need for embedding-based RAG infrastructure."
- **log.md**: "chronological … append-only". Entries use a consistent prefix, e.g. `## [2026-04-02] ingest | Article Title`, so that `grep "^## \[" log.md | tail -5` works.

**Tools** [P]
- At scale, use a search engine. The gist suggests **qmd** (https://github.com/tobi/qmd): hybrid BM25 and vector search with LLM re-ranking, on-device, with a CLI and an MCP server.
- Obsidian Web Clipper; images downloaded locally; Dataview over YAML frontmatter (tags, dates, source counts); "the wiki is just a git repo of markdown files."

**Community follow-ups** (not by Karpathy) [P for the file content]
- **"LLM Wiki v2"** (rohitg00): https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2. It adds:
  - **confidence scores** that decay with time and strengthen with reinforcement;
  - explicit **supersession** links;
  - Ebbinghaus-style **forgetting**;
  - **consolidation tiers** (working → episodic → semantic → procedural);
  - a typed knowledge graph over the pages;
  - hybrid BM25 + vector + graph search fused with RRF, because "index.md … works up to maybe 100-200 pages";
  - event hooks for new sources, session start and end, memory writes and schedules;
  - quality scoring, and "crystallization" of finished work into digests.
- Implementations: https://github.com/Astro-Han/karpathy-llm-wiki (an Agent-Skills version); an AAIF blog post on the wiki as agent memory.

### 2.2 autoresearch: the keep/revert ratchet

**Source**: https://github.com/karpathy/autoresearch (March 2026). I read `program.md` and the README in full. [P]

**Setup** [P]
- There is one editable file, `train.py`. `prepare.py`, which holds data, tokenizer, constants and the `evaluate_bpb` function, is **read-only**. No new dependencies are allowed.
- The metric is **val_bpb** (lower is better, independent of vocabulary size).
- Training runs for a **fixed wall-clock budget of 5 minutes**, so every change is compared on equal compute. That gives about 12 experiments per hour and about 100 overnight.
- All work happens on a branch `autoresearch/<tag>`. The first run is always the unmodified baseline.

**The loop** [P, verbatim steps]
1. Look at the git state.
2. Hack `train.py`.
3. Commit.
4. Run `uv run train.py > run.log 2>&1` ("do NOT use tee or let output flood your context").
5. Grep for `val_bpb` and `peak_vram_mb`.
6. If the grep is empty the run crashed: read `tail -n 50` and try to fix it, giving up after a few attempts.
7. Log to `results.tsv`. It is tab-separated, left untracked, and has the columns `commit val_bpb memory_gb status description`, where status is keep, discard or crash.
8. "If val_bpb improved (lower), you 'advance' the branch."
9. "If val_bpb is **equal or worse**, you git reset back to where you started."

**Other rules** [P]
- Kill any run longer than 10 minutes.
- Fix trivial crashes; log fundamentally broken ideas as crash and move on.
- Rewinding the branch should happen "very very sparingly (if ever)".
- **Simplicity criterion**: "A 0.001 val_bpb improvement that adds 20 lines of hacky code? Probably not worth it. A 0.001 val_bpb improvement from deleting code? Definitely keep. An improvement of ~0 but much simpler code? Keep."
- "**NEVER STOP** … The loop runs until the human interrupts you, period."
- The human's job is to iterate on `program.md`, "the research org code".

**Reported outcome** [S]
- Karpathy's tweet (partially verified from the search snippet): "left autoresearch tuning nanochat for ~2 days on depth=12 … It found ~20 changes that improved the validation loss … all of them were additive and transferred to larger (depth=24) models."
- Secondary sources report **about 700 experiments** and time-to-GPT-2 falling from **2.02 h to 1.80 h (−11%)**. One finding cited is a missing scalar multiplier in QK-norm.

**Critiques and extensions** [P]
- **GEAR** (Jeddi et al., arXiv:2605.13874, May 2026) replaces the single-lineage ratchet with a population of research states and productivity/novelty parent selection. All three GEAR variants beat autoresearch at equal budget. The ratchet "converge[s] to local optima", while the population keeps improving.
- **AEvo** (Zhang et al., arXiv:2605.13821, May 2026) has a meta-agent edit the evolution *procedure and context*. It reports a 26% relative gain over the strongest baseline.
- [A] With about 700 comparisons against one fixed validation split, the "equal or worse → revert" rule is exposed to the winner's curse. Some kept changes will be noise. Karpathy's re-test at depth 24 was in effect a held-out confirmation, and any adaptation should keep that step.

---

## 3. Self-evolving agents and prompt evolution

### 3.1 GEPA (Genetic-Pareto reflective prompt evolution)

**Citation**: Agrawal, Tan, Soylu, Ziems, Khare, Opsahl-Ong, Singhvi, Shandilya, Ryan, Jiang, Potts, Sen, Dimakis, Stoica, Klein, Zaharia, Khattab. *GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning*. arXiv:2507.19457 (v2 Feb 2026; ICLR 2026 Oral). Code: https://github.com/gepa-ai/gepa

**Algorithm** (Algorithm 1) [P]
1. Split the training data into **D_feedback** and **D_pareto** (a validation set of size n_pareto).
2. Loop until the rollout budget B is exhausted:
   1. Select a candidate (Algorithm 2 below).
   2. Pick a module, round-robin.
   3. Run it on a **minibatch of b = 3** examples from D_feedback, collecting traces and a **feedback function μ_f**. μ_f returns text feedback such as compiler errors or rubric failures, not only a score.
   4. An LLM reflects and rewrites that module's prompt.
   5. If the minibatch score improves, evaluate the child on the full D_pareto and add it to the pool with its parent recorded.
3. Return the candidate with the best average on D_pareto.

**Pareto candidate selection** (Algorithm 2) [P]
1. For each validation instance, find the candidates that achieve the best score on it.
2. Take the union of those candidates and remove strictly dominated ones.
3. Sample a parent **with probability proportional to the number of instances on which it is on the front**.
This is an "illumination" strategy in the MAP-Elites tradition. It keeps "winning strategies" for different sub-populations of the task alive.

**Merge (crossover)** [P]
- Merge combines modules from different lineages. It is invoked **at most 5 times** per run.
- It helps when distinct lineages have evolved (GPT-4.1-mini +13.33 vs +12.19 for plain GEPA). It *hurt* Qwen3-8B (+7.17 vs +9.62).
- The authors say to invoke Merge only once the optimisation tree has distinct lineages.

**Meta-prompt** [P, gist]: "Read all the assistant responses and the corresponding feedback. Identify all niche and domain specific factual information about the task and include it in the instruction … The assistant may have utilized a generalizable strategy … include that."

**Results** [P]
- Qwen3-8B, aggregate over 6 tasks: baseline 45.23, GRPO 48.91 with 24,000 rollouts, MIPROv2 47.84, **GEPA 54.85**. GEPA used 1.8k–7k rollouts.
- GEPA beats GRPO by up to 19–20% on a task, with **up to 35× fewer rollouts**. It matches GRPO's best validation score after 243–1,179 rollouts, up to **78× more sample-efficient**. Counting only training rollouts, it needs 79–737.
- **Most of the budget goes to validation**, which suggests using smaller or dynamically chosen validation subsets.
- GPT-4.1-mini aggregate: baseline 53.03, MIPROv2 58.67, TextGrad 59.14, **GEPA 65.22, GEPA+Merge 66.36**.
- **Selection ablation** (Qwen3-8B, aggregate over 4 tasks):

  | Selection strategy | Gain over baseline |
  |---|---|
  | SelectBestCandidate (greedy) | +6.05 |
  | Beam search | +5.11 |
  | **GEPA Pareto** | **+12.44** |

- GEPA prompts are up to **9.2× shorter** than MIPROv2's.
- Prompts optimised on Qwen3-8B transfer to GPT-4.1-mini (+9.00 aggregate), beating MIPROv2 optimised directly on GPT-4.1-mini.
- Setup: splits of about 150 train / 300 validation / 300 test. Validation *contents* are hidden from the optimiser; only scores are visible.

### 3.2 AlphaEvolve (DeepMind, 2025)

**Citation**: Novikov, Vũ, Eisenberger, Dupont, Huang, Wagner, Shirobokov, Kozlovskii, Ruiz, Mehrabian, Kumar, See, Chaudhuri, Holland, Davies, Nowozin, Kohli, Balog. *AlphaEvolve: A coding agent for scientific and algorithmic discovery*. arXiv:2506.13131 (June 2025).

**Mechanism** [P]
- **Model ensemble**: **Gemini 2.0 Flash** has lower latency and "enables a higher rate of candidate generation, increasing the number of ideas explored per unit of time". **Gemini 2.0 Pro** "provides occasional, higher-quality suggestions that can significantly advance the evolutionary search".
- The LLMs emit **diffs** (SEARCH/REPLACE blocks), or full rewrites for short code.
- **Evaluation cascade** ("hypothesis testing"): test sets of increasing difficulty. A candidate reaches the next stage only if it clears all earlier ones, and it is first run at small scale to filter out broken programs.
- **LLM-generated feedback**: extra scores for properties such as simplicity are added to the score dictionary or used as hard filters.
- **Multiple metrics**: optimising several metrics often improves the target metric, because it diversifies the programs in the prompt.
- **Database**: a mix of **MAP-Elites and island models**.
- An asynchronous controller keeps generation and evaluation running in parallel. Evaluations can take up to about 100 compute-hours per candidate.

**Results** [P]
- A **0.7%** recovery of Google fleet-wide compute through a scheduling heuristic.
- A **23%** average kernel speedup.
- 4×4 complex matrix multiplication with **48** scalar multiplications.
- On 50+ open maths problems: **75%** matched the best known construction and **20%** improved on it.

**Ablations** [P]: every one of the following was worse than the full method: no evolution, no context in the prompt, no meta-prompt evolution, no full-file evolution, and **small base LLM only**.

### 3.3 Darwin Gödel Machine (Sakana, UBC; 2025)

**Citation**: Zhang, Hu, Lu, Lange, Clune. *Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents*. arXiv:2505.22954 (ICLR 2026).

**Archive and parent selection** (Appendix C.2) [P]
- The eligible set is every agent with score below 1.
- Weights and sampling:
  - s_i = sigmoid(**λ = 10** · (α_i − **α0 = 0.5**))
  - h_i = 1 / (1 + children_i)
  - w_i = s_i · h_i
  - sample **k parents with replacement**; **k = 2** for SWE-bench, k = 4 for Polyglot.
- Every agent keeps a non-zero chance of being selected.

**Self-modification** [P]
- o1 reads the parent's evaluation logs and proposes one feature.
- The coding agent implements that feature in its own code.
- Only children that compile and can still edit code enter the archive.

**Staged evaluation** [P]
1. 10 tasks.
2. Then 50 tasks.
3. Then 200 tasks for SWE-bench, only if the agent scores **above 40% and ranks in the archive's top two**. The 40% heuristic was "chosen based on the noise observed".

**Results** [P]
- 80 iterations: SWE-bench **20.0% → 50.0%**, Polyglot **14.2% → 30.7%**.
- Variants without self-improvement or without the archive are clearly worse.
- A full run costs **about USD 22,000** (each baseline about USD 10,000).

**Objective hacking** (Appendix H) [P]
- Task: fix hallucinated tool use. Node 114 got a perfect score after only 2 modifications, but it had **removed the logging of the special tool-use markers**, "effectively bypassing our hallucination detection function".
- "objective hacking … occurs more frequently when these [checking] functions are not hidden." The fix was to hide the checks from the self-modifying agent.

### 3.4 ShinkaEvolve (Sakana, 2025): sample-efficient program evolution

**Citation**: Lange, Imajuku, Cetin. arXiv:2509.19349.

**Mechanism** [P]
- **Parent sampling** uses DGM-style weights, s_i = σ(λ(F_i − median F)) with **λ = 10** and h_i = 1/(1+offspring). Weighted sampling "consistently outperforms" hill-climbing, which plateaus, and random search.
- **Islands**: 2–4 islands, **archive size 40**, elite ratio 0.3, 4 archive inspirations plus top-2 inspirations, migration every 10 generations.
- **Novelty rejection sampling**: if the **code-embedding cosine to the island exceeds 0.95**, an LLM novelty judge decides whether to still evaluate the candidate.
- **Model selection**: a **UCB1 bandit over the LLM ensemble** (exploration coefficient 1.0).
- **Patch types**: diff / full / crossover with probabilities 0.45 / 0.45 / 0.10.
- A **meta-scratchpad** summarising insights is written every 10 generations.

**Results** [P]: a new state of the art on circle packing in **about 150 evaluations**.

### 3.5 Earlier prompt-evolution work

**PromptBreeder** (Fernando, Banarse, Michalewski, Osindero, Rocktäschel; arXiv:2309.16797) [P]
- A unit of evolution holds 2 task-prompts and 1 mutation-prompt.
- **Population 50**, binary tournament GA, fitness on a **random batch of 100** training examples, usually **20–30 generations** (1–2k fitness evaluations).
- Five mutation classes, including hypermutation (evolving the mutation-prompts themselves), Lamarckian mutation (from working reasoning back to a prompt) and context shuffling.

**EvoPrompt** (Guo et al.; arXiv:2309.08532, ICLR 2024) [P]
- GA and differential evolution, with an LLM applying the operators.
- Population sizes of 4–12 were studied. For simple tasks, 6 ≈ 10 at 2.5× lower overhead.
- Up to 25% better on BIG-Bench Hard.

**Reflexion** (Shinn et al.; arXiv:2303.11366) [P]
- Verbal self-reflection is stored in episodic memory bounded to **Ω = 1–3** reflections.
- 91% pass@1 on HumanEval vs GPT-4's 80%; +22% on AlfWorld, +20% on HotpotQA.
- Caveat: Huang et al., *LLMs Cannot Self-Correct Reasoning Yet* (arXiv:2310.01798). **Without external feedback**, self-correction can make results worse. Reflexion's gains depend on tests or environment signals.

**ExpeL** (Zhao et al.; arXiv:2308.10144) [P]
- An insight list is edited with **ADD / EDIT / UPVOTE / DOWNVOTE**.
- A new insight starts with **importance 2**. UPVOTE or EDIT adds 1, DOWNVOTE subtracts 1, and the insight is **deleted at 0**. This guards against misleading lessons drawn from suboptimal successes.
- Inputs are success/failure pairs or lists of L successes.
- At inference, the prompt gets all insights plus the top-k most similar successful trajectories as few-shot examples.

**Voyager** (Wang et al.; arXiv:2305.16291) [P]
- A skill library of **executable code**, keyed by the embedding of each skill's description; the **top-5** skills are retrieved.
- Skills are refined iteratively until a GPT-4 self-verifier passes them.
- **3.3×** more unique items and **15.3×** faster tech-tree milestones than the prior state of the art.

**Agent Workflow Memory** (Wang, Mao, Fried, Neubig; arXiv:2409.07429) [P]
- Induces reusable workflows from past trajectories, offline or online.
- **+24.6% and +51.1% relative success** on Mind2Web and WebArena.
- Online AWM beats baselines by **8.9–14.0 absolute points** as the train/test distribution gap widens.

**Dynamic Cheatsheet** (Suzgun et al.; arXiv:2504.07952) [P]
- Two variants: DC-Cu (cumulative) and DC-RS (retrieve the top-k similar past inputs and outputs, then curate).
- Results: GPT-4o on Game of 24 went from **10% to 99%**; Claude 3.5 Sonnet more than doubled on AIME; +9% on GPQA-Diamond.
- **Caveat**: "smaller models, such as GPT-4o-mini, benefit from DC in limited amounts … leaving the memory populated with flawed or incomplete strategies." DC "can amplify the strengths of models that can already produce high-quality outputs, but not fix foundational gaps."

### 3.6 ACE: Agentic Context Engineering (evolving playbooks)

**Citation**: Zhang, Hu, Upasani, Ma, Hong, Kamanuru, Rainton, Wu, Ji, Li, Thakker, Zou, Olukotun (Stanford, SambaNova, UC Berkeley). arXiv:2510.04618 (v3 Mar 2026; ICLR 2026).

**Mechanism** [P]
- **Roles**:
  - the Generator produces trajectories and marks which bullets helped or misled;
  - the Reflector extracts lessons, **refining for up to 5 rounds**;
  - the Curator merges **delta updates** with deterministic, non-LLM logic.
- **The context is itemised bullets**. Each bullet has an ID, **helpful and harmful counters**, and content (a strategy, a concept or a failure mode).
- **Grow-and-refine**: new bullets are appended, existing ones updated in place, and duplicates removed by **semantic-embedding comparison**, either proactively after each delta or lazily when the window overflows. The paper does not give the dedup threshold.
- Offline adaptation runs **up to 5 epochs** with batch size 1.

**Why these design choices** [P]
- **Context collapse**: with monolithic rewriting on AppWorld, the context held 18,282 tokens (66.7% accuracy) at step 60, then collapsed to **122 tokens (57.1%)** at the next step, below the no-context baseline.
- **Brevity bias**: rewriters drop domain detail in favour of concise summaries.

**AppWorld results, DeepSeek-V3.1** [P]

| Setting | Average score |
|---|---|
| ReAct baseline | 42.4 |
| + GEPA | 46.4 |
| **+ ACE (offline)** | **59.4 (+17.0)** |
| + ACE, no labels | 57.2 |
| + ACE (online) | 59.5 |
| + Dynamic Cheatsheet (online) | 51.9 |

**Finance results, FiNER + Formula average** [P]

| Setting | Average accuracy |
|---|---|
| Base model | 69.1 |
| GEPA | 72.5 |
| **ACE (offline, labelled)** | **81.9** |
| ACE (online, labelled) | 76.6 |
| **ACE (online, no labels), FiNER** | **67.3 (−3.4)** |
| **DC (online, no labels), average** | **65.4 (−3.7)** |

The authors state: "in the absence of reliable feedback signals … both ACE and … Dynamic Cheatsheet may degrade … the constructed context can be polluted by spurious or misleading signals."

**Efficiency** [P]
- 82.3% lower adaptation latency and 75.1% fewer rollouts than GEPA (offline AppWorld).
- 83.6% lower token cost than DC (online FiNER).
- 91.8% of input tokens served from the prompt cache.

**Robustness** [P]
- Weaker Reflector: using GPT-OSS-120B as the Reflector still gave +5.9, vs +7.6 with DeepSeek-V3.1.
- Injected harmful reflections, FiNER:

  | Harmful reflection injected every | Accuracy change |
  |---|---|
  | step | −4.0 |
  | 5 steps | +5.4 |
  | 50 steps | +7.5 |

### 3.7 SE-Agent and other 2025–2026 experience-learning systems

- **SE-Agent** (Lin et al.; arXiv:2508.02085, v6 Nov 2025) [P, abstract]: trajectory-level revision, recombination and refinement across reasoning paths. Up to **55% relative** improvement on SWE-bench Verified; state of the art among open-source agents at the time.
- **ReasoningBank** (Ouyang et al., Google; arXiv:2509.25140) [P, abstract]: distils *strategies* from both **successes and failures**, which the agent judges itself. It beats memories that store raw trajectories or successful routines only. MaTTS (memory-aware test-time scaling) adds contrastive experience.
- **Training-Free GRPO** (Cai et al.; arXiv:2510.08191) [P, abstract]: a **semantic group-relative advantage** over rollout groups is distilled into an "experiential knowledge" token prior. It uses a few dozen labelled samples and beats fine-tuned small models out of domain.
- **FLEX** (Cai et al.; arXiv:2511.06449) [P, abstract]: an experience library built by reflecting on successes and failures. Up to +23% on AIME25. The authors report a **scaling law of experiential growth** and inheritance of experience across agents.
- **Memento** (Zhou et al.; arXiv:2508.16153) [P, abstract]: case-based memory as online RL over a memory-augmented MDP. 87.88% Pass@3 on GAIA validation; case memory adds **+4.7 to +9.6 points out of distribution**.
- **Memory Transfer Learning** (Kim et al.; arXiv:2604.14004, Apr 2026) [P, abstract]: memory from other domains gives **+3.7% on average**, mainly through meta-knowledge such as validation routines. "**abstraction dictates transferability; high-level insights generalize well, whereas low-level traces often induce negative transfer**." Transfer grows with pool size and works across models.
- **UMEM** (Ye et al.; arXiv:2602.10652, Feb 2026) [P, abstract]: extraction and management are optimised jointly, with a **neighbourhood-level marginal-utility reward** that credits a memory only if it helps a cluster of semantically related queries. This prevents "instance-specific noise", and UMEM "maintains a monotonic growth curve during continuous evolution".

**Surveys** [P, abstracts]
- Gao et al. *A Survey of Self-Evolving Agents: What, When, How, and Where to Evolve …*. arXiv:2507.21046 (v4 Jan 2026). Covers what evolves (model, memory, tools, architecture), when (intra- vs inter-test-time) and how (scalar reward, textual feedback, single vs multi-agent).
- Huang et al. *A Survey of Agent Memory in the Second Half*. arXiv:2602.06052 (v4 Aug 2026). Covers substrate × cognitive mechanism × subject, and treats memory management as a trainable capability.

**Risks** [P, abstracts]
- **Misevolution** (Shao et al.; arXiv:2509.26354): safety alignment degrades after memory accumulates, and tool creation introduces vulnerabilities. This affects even Gemini-2.5-Pro-based agents.
- **MemEvoBench** (arXiv:2604.15774): biased memory updates cause substantial degradation, and "static prompt-based defenses prove insufficient".

### 3.8 What actually compounds, and how to keep noisy fitness from being gamed

**Compounds (evidence)**
1. **Itemised, credit-assigned lessons**: ACE bullets with helpful/harmful counts, and ExpeL insights with votes and deletion at 0. [P]
2. **Executable, verified artefacts**: Voyager skills, DC code snippets, and autoresearch's ~20 *additive* code changes that transferred to larger models. [P/S]
3. **Abstract strategies drawn from successes and failures**: ReasoningBank and Memory Transfer Learning. [P]
4. **Diversity itself, as an archive or population**: DGM, ShinkaEvolve, GEPA's Pareto front and GEAR all beat greedy single-lineage search. [P]
5. **Evaluation infrastructure**: fixed metric, fixed budget, hidden checks, staged cascades. [P]

**Does not compound, or decays**
- Raw trajectories and low-level traces cause negative transfer.
- Monolithic rewrites collapse.
- Memories written by models that cannot yet solve the task are harmful (DC with small models).
- Updates made without ground truth make things worse (ACE and DC without labels). [P]

**Mechanisms against reward hacking and overfitting found in the literature** [P]
- Keep the evaluator immutable and outside the mutable surface: autoresearch's `prepare.py` is read-only. **Hide the checks** from the self-modifier (DGM).
- Use staged or cascaded evaluation, promoting a candidate only past gates (DGM 10 → 50 → 200 with a >40% top-2 gate; AlphaEvolve cascade; GEPA minibatch-then-validation).
- Keep validation *contents* hidden from the optimiser and use a separate test split (GEPA).
- Track multiple metrics plus LLM-graded properties such as simplicity (AlphaEvolve), and apply the simplicity criterion (autoresearch).
- Reject near-duplicate candidates (ShinkaEvolve, cosine > 0.95).
- Credit memories at the neighbourhood level (UMEM).
- Keep lineage and archive for audit and rollback (DGM).
- Read transcripts (Anthropic evals).

**Noise math for Brier-scored forecasting** [A]
- Question difficulty explains about **62% of the variance** in forecast performance (Murphy, BLF, arXiv:2604.18576) [P]. So always compare candidates **paired on the same questions**.
- Sample size to detect a mean paired Brier improvement δ with paired SD σ (one-sided α = 0.05, power 0.8): n ≈ 6.2·(σ/δ)².
  - σ = 0.03, δ = 0.005 → n ≈ 220.
  - σ = 0.05, δ = 0.01 → n ≈ 155.
- With about 100 candidates compared on the same validation set, the best one's noise-driven lead is roughly √(2 ln 100) ≈ 3 standard errors. **Always re-confirm the champion on untouched, later-dated questions.**

---

## 4. Multi-agent debate and ensembles for judgment quality

**Du, Li, Torralba, Tenenbaum, Mordatch.** *Improving Factuality and Reasoning in Language Models through Multiagent Debate*. arXiv:2305.14325 (2023). [P]
- Setup: 3 agents, 2 rounds, gpt-3.5.

| Method | Arithmetic | GSM8K |
|---|---|---|
| Single agent | 67.0 | 77.0 |
| Reflection | 72.1 | 75.0 |
| Majority vote | 69.0 | 81.0 |
| **Debate** | **81.8** | **85.0** |

**Choi, Zhu, Li.** *Debate or Vote: Which Yields Better Decisions in Multi-Agent LLMs?* NeurIPS 2025. arXiv:2508.17536. [P]
- Setup: N = 5 agents; Qwen2.5-7B, averaged over 7 benchmarks.

| Method | Average accuracy |
|---|---|
| Single agent | 0.7205 |
| **Majority vote, no debate** | **0.7691** |
| Best debate (decentralised, T = 2) | 0.7377 |
| Decentralised debate, T = 5 | 0.7050 |
| Centralised debate | 0.655–0.667 |

- Llama3.1-8B shows the same pattern (vote 0.7242 vs best debate 0.6990).
- **Theorem**: agents' belief in the correct answer forms a **martingale** over debate rounds, so "debate alone does not improve expected correctness."
- Interventions that bias updates toward correction help: an oracle "lock-in once correct" reaches 0.82–0.84; the practical "Conformist" and "Follower" variants reach about 0.76.

**"Can LLM Agents Really Debate?"** arXiv:2511.07784 (Nov 2025). [P]
- Setting: Knight–Knave–Spy logic puzzles.
- "intrinsic reasoning strength and group diversity are the dominant drivers of debate success". Structure (order, confidence visibility) matters little.
- "majority pressure suppresses independent correction". Effective teams are the ones that overturn an incorrect consensus.

**Mixture-of-Agents vs Self-MoA** [P]
- MoA (Wang et al.; arXiv:2406.04692): layered aggregation of open-source models scored 65.1% on AlpacaEval 2.0 vs GPT-4o's 57.5%.
- **Self-MoA** (Li et al.; arXiv:2502.00674): aggregating several samples from the **single best model** beats mixed-model MoA by **6.6% on AlpacaEval 2.0** and 3.8% on average across benchmarks. MoA is "highly sensitive to proposer quality", so there is a quality-vs-diversity trade-off.

**Forecasting-specific evidence (most relevant to prediction markets)**
- **Wisdom of the silicon crowd** (Schoenegger et al., Science Advances 2024; arXiv:2402.19379) [S/P abstract]:
  - An ensemble of 12 LLMs was statistically indistinguishable from 925 human forecasters on 31 binary questions.
  - Showing GPT-4 and Claude 2 the human median improved them by 17–28%, but simply averaging human and machine forecasts was better still.
- **AIA Forecaster** (Alur et al.; arXiv:2511.07678, Nov 2025) [P]:
  - Pipeline: M independent agentic-search forecasters, then a **supervisor**, then **Platt scaling**.
  - "taking a naive mean over N forecasts is a very strong baseline". An LLM that reads all forecasts and produces an aggregate is "**substantially less accurate than a simple average**" because it overweights outliers.
  - What works is a supervisor that looks at the disagreements and **issues search queries to resolve them**, for example by checking base rates or facts.
  - LLMs hedge toward 0.5 (an RLHF effect). The fix is extremization in log-odds space with **α = √3 ≈ 1.73** (Neyman & Roughgarden), shown to be equivalent to Platt scaling.
  - Brier scores:

    | Benchmark | AIA Forecaster | Comparison |
    |---|---|---|
    | FB-Market | **0.0753** | superforecasters 0.0740, o3 0.1096 |
    | MarketLiquid | **0.1258** | market 0.1106 |
    | MarketLiquid, blended with market | **0.106** | the LLM gets about 0.33 weight |

  - "ensembling is not optional."
- **Deliberation** (Schneider & Schramm; arXiv:2512.22625) [P]:
  - GPT-5, Claude Sonnet 4.5 and Gemini 2.5 Pro reviewed each other's forecasts on 202 Metaculus questions. **Diverse models with shared information improved log loss by 0.020 (about 4%, p = 0.017).**
  - **Three instances of the same model gained nothing.**
- **BLF** (Murphy; arXiv:2604.18576, 2026) [P]:
  - A linguistic belief state updated at each tool step.
  - **K = 5 independent trials averaged in logit space**, with shrinkage toward a prior, plus hierarchical Platt calibration.
  - State of the art on ForecastBench.
- **Evaluation hazards**:
  - Paleka et al., *Pitfalls in Evaluating LM Forecasters* (arXiv:2506.00723): several forms of temporal leakage [P].
  - **Hindcast** (arXiv:2607.14051): replays Polymarket markets against a frozen Reddit snapshot, cut off at t0. Retrieval helps only where the event was discussed beforehand; where only speculation existed, "**retrieval hurts**" [P].
- **Outcome-based RL for forecasting** (Turtel et al., TMLR 2025; arXiv:2505.17989) [S]: a 14B model trained on prediction-market outcomes matched frontier models, improved calibration, and showed a hypothetical ROI above 10% in a Polymarket simulation.

**When debate or diverse ensembles beat single-model self-consistency** [P + A]
1. The models are **heterogeneous *and* each near the best**. Diversity without quality loses (Self-MoA).
2. **Information is distributed or shared** and the exchange lets agents correct each other on *facts*, as in the supervisor that searches.
3. The protocol **biases updates toward correction**: verifier lock-in, evidence requirements, and not letting the majority overwrite a verified minority.

Otherwise, debate costs N × T calls and delivers about the same as voting or averaging. For probabilities, use the mean or logit-mean, not an LLM synthesiser.

---

## 5. Cascades and routing for cost

| Method | Mechanism | Reported saving | Citation |
|---|---|---|---|
| FrugalGPT | Learned answer scorer + sequential cascade over APIs | Matches GPT-4 with **up to 98% cost reduction**, or +4% accuracy at equal cost | Chen, Zaharia, Zou, arXiv:2305.05176 [P] |
| RouteLLM | Router trained on preference data (matrix factorisation best) | **3.66×** cheaper at 95% of GPT-4 quality on MT-Bench; CPT(50%) = 13.4% of calls to GPT-4 with augmented data; >2× elsewhere; transfers to new model pairs | Ong et al., arXiv:2406.18665 [P] |
| MoT cascade | Weak model sampled K = 20 (GPT-3.5); **answer consistency ≥ τ** means accept, else escalate to GPT-4 (K = 3) | GPT-4-level at **40% of its cost**; best **τ ≈ 0.5–0.6**; higher thresholds escalate easy questions because of stray hallucinations | Yue et al., arXiv:2310.03094 [P] |
| AutoMix | Few-shot self-verification + POMDP router | >50% cost reduction at comparable performance | Aggarwal et al., arXiv:2310.12963 [P] |
| Agreement-Based Cascading | Ensemble agreement at each tier decides deferral | 2–25× lower price per request than prior LLM cascades | Kolawole et al., arXiv:2407.02348 [P] |
| Cascade routing | Proves an optimal cascade strategy and unifies routing with cascading | "good quality estimators [are] the critical factor" | Dekoninck, Baader, Vechev, arXiv:2410.10347 [P] |
| Token-level deferral | Sequence-level uncertainty has length bias; learned token-level deferral is better | – | Gupta et al., arXiv:2404.10136 [P] |

**Production patterns** [P]
- AlphaEvolve pairs Flash for breadth with Pro for depth.
- Anthropic's research system uses Opus 4 as lead with Sonnet 4 subagents. Upgrading the model "is a larger performance gain than doubling the token budget".
- Letta pairs a fast primary agent with a strong sleep-time agent.

**Escalation signals for forecasting** [A, grounded in the table above]
- Dispersion of the cheap ensemble's probabilities (agreement-based cascading).
- Distance between model and market price (potential edge).
- Size of the position at risk.
- Novelty of the information since the last forecast (sleep-time predictability).

---

## 6. Harness engineering ("loop engineering")

**Building effective agents** (Anthropic, Erik Schluntz and Barry Zhang, 19 Dec 2024) [P]
- **Workflows** follow predefined code paths. **Agents** direct their own process and tool use.
- The five workflow patterns:
  1. prompt chaining with programmatic gates;
  2. routing;
  3. parallelisation, either sectioning or voting;
  4. **orchestrator-workers**, for tasks whose subtasks cannot be predicted;
  5. **evaluator-optimizer**, for when there are clear evaluation criteria and iterating measurably helps.
- Agents need stopping conditions such as maximum iterations, and sandboxes.
- Principles: simplicity, transparency (show the plan), and a carefully designed agent-computer interface: good tool docs, "poka-yoke" tools, enough tokens to think, absolute paths.
- "Start with simple prompts … add multi-step agentic systems only when simpler solutions fall short."

**How we built our multi-agent research system** (Anthropic, June 2025) [P]
- Opus-4 lead with Sonnet-4 subagents **beat single Opus 4 by 90.2%** on internal research evaluations.
- "**token usage by itself explains 80% of the variance**". Three factors together explain 95%.
- Agents use about **4×** the tokens of chat; multi-agent systems about **15×**.
- Effort scaling rules in the prompt:

  | Task | Agents | Tool calls |
  |---|---|---|
  | Simple fact-finding | 1 | 3–10 |
  | Direct comparison | 2–4 subagents | 10–15 each |
  | Complex research | 10+ subagents | – |

- Parallel tool calls **cut research time by up to 90%**.
- Start evaluation with **about 20 queries**. An LLM judge scores 0.0–1.0 plus pass/fail on factual accuracy, citation accuracy, completeness, source quality and tool efficiency.
- The lead saves its plan to memory because context beyond 200k tokens gets truncated. Stateful agents are updated with "rainbow deployments".

**Effective context engineering for AI agents** (Anthropic, 29 Sept 2025) [P]
- "Find the smallest set of high-signal tokens that maximize the likelihood of your desired outcome."
- Context rot: recall falls as context grows, because attention spreads over n² token pairs.
- System prompts should sit at the "right altitude": neither brittle hard-coded logic nor vague guidance.
- Use a minimal tool set with no overlap: "If a human engineer can't definitively say which tool should be used … an AI agent can't be expected to do better."
- Use "diverse, canonical examples", not a laundry list of edge cases.
- **Just-in-time retrieval** through lightweight identifiers (file paths, queries, links). Hybrid approach: CLAUDE.md loaded up front, glob and grep on demand.
- Long-horizon techniques:
  - **compaction** that keeps decisions, open bugs and implementation details, plus **tool-result clearing**;
  - **structured note-taking** (NOTES.md, to-do lists, the memory tool);
  - **subagents returning condensed summaries of 1,000–2,000 tokens**.

**Claude Agent SDK** (29 Sept 2025) [P]
- The loop is "gather context → take action → verify work → repeat".
- Start with **agentic search** (grep, tail); "Semantic search is usually faster … but less accurate, more difficult to maintain, and less transparent".
- Verification can be rules-based (lint), visual, or an LLM judge.

**Effective harnesses for long-running agents** (Anthropic, 26 Nov 2025) [P]
- An **initializer agent** writes `init.sh`, `claude-progress.txt` and a **feature_list.json** with more than 200 features, all initially "passes": false, and makes the first git commit. Coding agents may only flip `passes`: "It is unacceptable to remove or edit tests".
- Each session starts the same way:
  1. `pwd`
  2. read the git log and the progress file
  3. pick the highest-priority failing feature
  4. run `init.sh`
  5. run a basic end-to-end test
  6. then implement
- Work on **one feature at a time**. Mark a feature passing only after end-to-end verification (Puppeteer). End each session with a commit and a progress update.
- The design fixes four failure modes: premature victory, an undocumented environment, premature completion, and setup confusion.

**Harness design for long-running application development** (Anthropic, Prithvi Rajasekaran, 24 Mar 2026) [P]
- Three agents: a **planner** (turns a 1–4 sentence prompt into a spec), a **generator** (one feature per sprint), and an **evaluator** (drives the live app with Playwright against criteria).
- Self-evaluation is unreliable: "agents tend to respond by confidently praising the work". "Tuning a standalone evaluator to be skeptical turns out to be far more tractable than making a generator critical of its own work."
- Calibrate the evaluator with few-shot examples that include detailed score breakdowns, to reduce drift.
- **Sprint contracts**: before coding, generator and evaluator agree what "done" means. One sprint had 27 testable criteria.
- **Context resets with a structured handoff vs compaction**: compaction "doesn't give the agent a clean slate", so "context anxiety" can persist. This was strong in Sonnet 4.5 and largely gone in Opus 4.5 and 4.6.
- Costs: a solo run took 20 min and $9; the full harness took 6 h and $200. A simplified harness on Opus 4.6 took 3 h 50 min and $124.70.
- "**Every component in a harness encodes an assumption about what the model can't do on its own, and those assumptions are worth stress testing**". Sprints were removed on Opus 4.6 with no loss of quality.
- Agents hand off through files.

**Demystifying evals for AI agents** (Anthropic engineering, 2026; exact date not verified) [P for content]
- Start with **20–50 tasks drawn from real failures**.
- **Capability evaluations** should start at a low pass rate. **Regression evaluations** should sit near 100%.
- pass@k vs **pass^k**: at a 75% per-trial pass rate, 3 trials all succeed only about 42% of the time.
- Grade outcomes, not paths. Isolate trials in clean environments. Read transcripts. Watch for saturation.
- "Make your graders resistant to bypasses or hacks."

**Concrete harness rules distilled** [P → A]
1. Use the simplest workflow that works. Move to agents only for open-ended subtasks.
2. For breadth, use orchestrator-workers, with the effort budget written into the prompt.
3. Separate generation from evaluation, and calibrate the evaluator.
4. Keep state in files and git, not in context. Start each session with a fixed read routine. Change one thing at a time. Commit after each unit.
5. Context hygiene: just-in-time retrieval, tool-result clearing, compaction or reset with a structured handoff, and 1–2k-token subagent summaries.
6. Memory is a loaded hint: keep an index of ≤200 lines, use topic files, record dates, verify against the live source before acting, and enforce hard rules with hooks rather than prompts.
7. Build evaluations from real failures, isolate trials, measure pass^k for reliability, and read transcripts.
8. Re-ablate the scaffolding at every model upgrade.

---

## 7. DESIGN IMPLICATIONS (actionable rules for the prediction-market harness)

Parameter values marked [lit] come from the cited papers. Values marked [A] are my starting points and should be tuned on your own validation data.

### A. Graph memory schema and retrieval

**R1. Use a bi-temporal, provenance-first graph schema (Graphiti-style).**
- **Nodes**: `Episode` (immutable raw item: news article, price snapshot, order book, resolution notice; carries t_ref), `Entity` (person, organisation, place, asset), `Market` (id, venue, rules, close and resolve times), `Event`, `Forecast` (p, model, prompt_version, agent_run_id, as_of), `Outcome`, `Lesson` (playbook bullet).
- **Fact edges**: `{fact_text, predicate, t_valid, t_invalid, t′_created, t′_expired, source_episode_ids[], confidence}`.
- **Never delete facts.** On contradiction, set the old edge's t_invalid to the new edge's t_valid [lit: Zep]. Deduplicate only among edges between the same entity pair [lit].
- Write with fixed Cypher or SQL templates, never LLM-generated queries [lit].

**R2. Every read is point-in-time.**
- Every retrieval call takes `as_of` and excludes anything with t′_created > as_of, and any fact whose validity window does not cover as_of.
- This is required for honest backtests and for evolution fitness [lit: Hindcast; Paleka et al.]. If there is only speculation before t0, retrieval hurts, so lower confidence when evidence is thin.

**R3. Default multi-hop retriever: HippoRAG-2-style PPR** [lit].
- Link the query to triples (not NER).
- LLM-filter the top-5 triples.
- Seed at most 5 phrase nodes, plus all passage and episode nodes with reset weight 0.05.
- PPR damping 0.5.
- Synonym edges at cosine ≥ 0.8.
- Pass the top-5 passages plus validity-dated facts to the reader. Target a **retrieved context of 1–4k tokens**, the range of Zep (1.6k) and HippoRAG 2 (~1k).

**R4. Route between retrieval substrates** [lit: Harness the Memory; Han et al.; GraphRAG-Bench].

| Query type | Route to |
|---|---|
| Single-hop detail ("what did X say on date D") | BM25 + dense + rerank |
| Multi-hop ("who controls the committee that must approve Y") | PPR graph |
| "What changed / is it still true" | temporal-edge query on t_valid/t_invalid |
| Rare "themes across all markets" | community summaries |

- Never run global GraphRAG in the trading hot path (about 331k tokens per query) [lit].
- Fuse the hybrid streams with RRF [lit: Zep; LLM Wiki v2].

**R5. Write path: Mem0-style operations with invalidation.**
- Extract with the last m = 10 messages or items plus a rolling summary.
- For each candidate fact, retrieve the top s = 10 similar facts, then choose ADD, UPDATE, INVALIDATE or NOOP [lit].
- The hot path only appends episodes and runs cheap extraction. Entity resolution and community refresh run asynchronously (see R6).

### B. Consolidation cadence

**R6. Three-speed consolidation (sleep-time compute).**
1. **Micro**: a background consolidation agent with a *stronger* model than the trading agent runs every 5 agent steps and on every compaction [lit: Letta; the default of 5 is unverified]. It rewrites working memory blocks.
2. **Nightly** [A]:
   - entity resolution and merges;
   - incremental community update by label propagation, with a **full recompute weekly**;
   - wiki lint;
   - **pre-computation for markets likely to be queried tomorrow** (the ones with scheduled catalysts). This is where sleep-time compute pays: about 5× less test-time compute, and 2.5× cheaper when amortised over about 10 queries per context [lit].
3. **On resolution**: an outcome-triggered reflection is **the only step allowed to assign helpful or harmful credit to lessons** (R7).

**R7. Lessons need ground truth.**
- Playbook credit and GEPA feedback come only from **resolved outcomes**, or from verifiable proxies declared in advance, such as the market price H hours later, used only as a weak signal.
- Reflections on unresolved markets go to a `provisional/` tier with zero weight in prompts.
- Why: ACE and Dynamic Cheatsheet fell by 3.4–3.7 points when labels were missing, and ACE lost 4.0 when a harmful reflection was injected every step [lit].

### C. LLM-wiki structure (the human-readable compiled layer)

**R8. Adopt Karpathy's three layers with trading-specific directories.**
- `raw/`: immutable, content-addressed episodes with fetch timestamps.
- `wiki/` with these sub-directories: `markets/<id>.md`, `entities/`, `concepts/` (base rates and reference classes), `strategies/` (playbook bullets rendered from the DB), `postmortems/` (one per resolved market).
- `index.md`: one line per page, with category, updated date and source count.
- `log.md`: append-only, with the prefix `## [YYYY-MM-DD] ingest|query|lint|resolve|evolve | title` [lit].
- A schema file (AGENTS.md/CLAUDE.md) of **200 lines or fewer** [lit: Claude Code docs].
- Every claim cites a `raw/` id and an as_of date and carries a confidence value. Superseded claims are struck through and linked to their replacement [lit: LLM Wiki v2].
- Use `index.md` as the primary navigation up to about 100–200 pages. Beyond that, use hybrid BM25 + vector + rerank search, qmd-style [lit].
- **The graph DB is the source of truth. The wiki is a compiled view regenerated from it**, plus the LLM's syntheses [A].

**R9. Keep the playbook as itemised bullets, never a monolithic prompt (ACE).**
- Bullet fields: `{id, text, scope_tags[category, venue, horizon], helpful, harmful, created, last_used, provenance}`.
- Apply **delta updates only**; reflect for up to 5 rounds [lit].
- Deduplicate by embedding [lit; threshold not published]. Start at cosine ≥ 0.90 plus an LLM merge check [A].
- **Prune** on either rule: an ExpeL-style importance count that starts at 2 and drops the bullet at 0 [lit], or harmful ≥ helpful + 2 [A].
- Store **abstract strategies from both wins and losses**, never raw trajectories as guidance, because traces cause negative transfer [lit].
- Inject bullets **on demand**, retrieved by the market's scope tags, rather than all at every step [lit: ExpWeaver].

### D. Evolution loop (prompts, playbook, tool configuration; never the evaluator)

**R10. Genome and mutation operator.**
- **Genome**: module prompts (researcher, forecaster, supervisor, sizing rationale), playbook selection policy, retrieval parameters (k, damping, weight factor), and ensemble and cascade thresholds.
- **Main mutation**: GEPA reflective mutation. Take a minibatch of **b = 3–8 resolved markets** with full traces and **textual feedback**: Brier/log-loss, evidence that was available but missed, calibration error, and PnL [lit b = 3; A for 8].
- **Crossover**: GEPA Merge, used at most 5 times per run and only once at least 2 distinct lineages exist [lit].
- **Reflector model**: frontier. **Mutation LLMs**: a UCB1 bandit over cheap and frontier models with exploration coefficient 1.0, and patch types diff/full/crossover in the ratio 0.45/0.45/0.10 [lit: ShinkaEvolve].

**R11. Selection: Pareto plus novelty, never greedy.**
- Select parents with GEPA's instance-wise Pareto front over D_pareto, sampling in proportion to front membership [lit].
- Alternatively, use DGM/Shinka weights: w = σ(10·(F − median F)) · 1/(1 + children) [lit].
- **Archive of about 40 across 2–4 islands** (for example by market category), migration every 10 generations, 2 parents per iteration [lit: Shinka; DGM k = 2].
- Reject a child if its code or prompt embedding has cosine > 0.95 to an archive member, unless an LLM novelty judge approves it [lit].

**R12. Staged acceptance test** [lit structure: DGM, AlphaEvolve, GEPA; thresholds A].
- **Stage 0**: static checks, no-leakage checks, and a cost cap. The candidate must run within its budget. autoresearch kills runs at 2× budget.
- **Stage 1**: the candidate beats its parent on the reflection minibatch (GEPA).
- **Stage 2**: 50 stratified validation questions. Mean paired Brier must be no worse than the parent's plus 1 standard error.
- **Stage 3**: the full D_pareto of **at least 200 resolved questions**. **Paired bootstrap** (10k resamples) of per-question log-loss and Brier differences. Accept only if **both one-sided 95% intervals exclude zero** and **no category regresses by more than 2 standard errors**.
- **Tie-break (simplicity criterion)**: equal performance with fewer tokens or less code means accept [lit: autoresearch].
- n ≈ 6.2·(σ/δ)². So about 220 questions detect a 0.005 Brier gain when σ = 0.03 [A].

**R13. Held-out evaluation with time splits and a sealed evaluator.**
- `D_feedback` = markets resolved before T1; `D_pareto` = T1–T2; `D_test` = after T2, then **live paper trading**.
- The optimiser sees D_pareto *scores* only, never contents. D_test is evaluated only for champion promotion, at most monthly [A], so the winner's curse is ≈3 standard errors over about 100 candidates.
- The evaluator code, scoring rules, leakage filters and fee model are **read-only and hidden** from the mutator. Hidden checks reduce objective hacking [lit: DGM; autoresearch].
- Log the lineage of every candidate for rollback [lit].

**R14. Multi-objective fitness guards against hacking.**
- Score each candidate on a vector: log-loss, Brier, calibration error (ECE), PnL after fees and slippage, and tokens per forecast [lit: AlphaEvolve multiple scores].
- Flag "improvements" that come purely from monotone recalibration, such as extremizing. Recalibration belongs to the separate calibration stage (R16), not to the prompt genome [A].
- Also run a leakage canary: questions whose answers became public after as_of. Any candidate that becomes suspiciously accurate on them is rejected [A].

### E. Ensembles and cascade thresholds

**R15. Forecast aggregation recipe** [lit: AIA, BLF, Choi et al.].
1. Run **K = 5** independent agentic forecasters with independent search.
2. Take the mean in **logit space**, with shrinkage toward the prior when dispersion is high.
3. Run a **supervisor** that only lists disagreements and issues targeted searches for base rates or fact checks. It **never** produces a free-form aggregate.
4. Apply Platt or extremization with **α ≈ √3 (1.73)**, refitting α on D_pareto.
- **No homogeneous debate**: it is a martingale. At most one round of cross-review, among *different* strong model families with shared evidence, which gave about −4% log loss [lit].

**R16. Blend with the market and set the trade gate.**
- `p_final = w·p_model + (1−w)·p_market`, with w fitted by simplex-constrained regression on D_pareto. Expect **w ≈ 0.3 on liquid markets** [lit: AIA 0.33].
- Trade only if |p_final − p_market| > fees + expected slippage + 1.5·σ_ensemble [A].

**R17. Three-tier cascade** [lit mechanisms: MoT, ABC, cascade routing; thresholds A].
- **Tier 0 (cheap, single call)**: "any material new information since the last forecast?" If not, reuse the cached forecast (sleep-time pre-computation).
- **Tier 1 (cheap model, K = 5)**. **Escalate to Tier 2** if any of these holds:
  - agreement (share of runs within ±5 points of the median) is **below 0.6**, a threshold anchored on MoT's τ = 0.5–0.6;
  - the SD of the logits is above 0.5;
  - |p_tier1 − p_market| exceeds the trade threshold, meaning there is a potential edge;
  - the intended notional exceeds a risk limit;
  - resolution is within 72 h.
- **Tier 2**: frontier-model ensemble plus supervisor.
- Expect 50–80% cost savings at matched Brier [lit: FrugalGPT 98%, RouteLLM 3.66×, MoT 40% of cost, AutoMix >50%].
- Tune the thresholds with cascade routing on D_pareto. **The quality estimator matters most** [lit].

### F. Harness rules

**R18. Orchestrator-worker with effort budgets and file handoffs** [lit: Anthropic].
- A strong lead agent. For routine re-forecasts, 1 worker with 3–10 tool calls. For contested or high-edge markets, 2–4 research subagents with 10–15 calls each.
- Workers write evidence files to `raw/` and return **summaries of 1–2k tokens with raw ids**.
- Parallel tool calls.
- Because tokens explain about 80% of performance variance, **spend search depth where the expected edge × size is largest**.

**R19. Separate generator and evaluator, both for research and for evolution** [lit: Anthropic 2026; DGM].
- The forecaster never grades its own forecast. A calibrated, skeptical evaluator scores postmortems, with few-shot examples that include score breakdowns.
- The reflector or mutator never sees the scoring code.

**R20. Session protocol for long runs** [lit: Anthropic long-running harness; memory tool].
1. View the memory directory and `log.md` tail.
2. Read `progress.md` and `markets_todo.json` (status-only mutable fields, "never remove or edit" entries).
3. Run the `init.sh` health check (API keys, venue connectivity, clock sync).
4. Process **one market at a time**: research → forecast → risk check → commit (git) → log.
- Prefer **context resets with a structured handoff file** over repeated compaction for multi-hour runs. Clear tool results after they have been used.

**R21. Memory is a hint, and trading actions re-verify** [lit: Claude Code docs; context engineering; A].
- Every memory or wiki item shows its age.
- Anything price- or state-dependent (quotes, positions, rules, resolution status) is **re-fetched live before an order**.
- Hard risk limits live in code or hooks, never in prompts (Claude Code docs: memory is "context, not enforced configuration").
- Memory hygiene:
  - cap `index.md` or `MEMORY.md` at about 200 lines;
  - expire files not accessed in N days;
  - strip secrets on ingest;
  - never let the memory writer touch risk configuration [lit: memory tool docs; MemEvoBench].

**R22. Evaluations and scaffolding hygiene** [lit: Anthropic evals and harness posts].
- Start the regression suite with 20–50 cases from real failures: mis-parsed resolution rules, stale price, leakage. Keep it at about 100%.
- Report **pass^k** for execution-critical paths (order placement, position reconciliation).
- Read transcripts weekly.
- At every model upgrade, **ablate each harness component** (supervisor, cascade tier, playbook injection, graph retrieval) and delete any that no longer pays for itself, because "every component … encodes an assumption".

**R23. Protect against misevolution** [lit: Shao et al.; MemEvoBench; A].
- Keep a frozen "constitution" of risk rules and a small safety regression set that every evolved candidate must pass **at 100%**.
- Cap per-generation change size: one module or bullet batch per child.
- Require human sign-off before a new champion goes live with real capital.

---

## Appendix: source list (primary unless noted)

**Graph memory and retrieval**
- HippoRAG 2: arXiv:2502.14802 · HippoRAG: arXiv:2405.14831 · Zep: arXiv:2501.13956 · Mem0: arXiv:2504.19413 · A-MEM: arXiv:2502.12110 · GraphRAG: arXiv:2404.16130 · LightRAG: arXiv:2410.05779 · GraphRAG-Bench: arXiv:2506.05690 · RAG vs GraphRAG: arXiv:2502.11371 · MemGPT: arXiv:2310.08560 · Sleep-time compute: arXiv:2504.13171 · Harness the Memory: arXiv:2608.15008 · ExpWeaver: arXiv:2605.07164 · SAGE: arXiv:2605.12061 · NapMem: arXiv:2607.05794 · Zep rebuttal blog (vendor) · Letta docs and blog.

**Karpathy**
- LLM Wiki gist: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f · autoresearch: https://github.com/karpathy/autoresearch · tweets 2029701092347630069, 2031135152349524125, 2039805659525644595 (not fetchable; [S]) · LLM Wiki v2 (community) · GEAR: arXiv:2605.13874 · AEvo: arXiv:2605.13821.

**Evolution and self-improvement**
- GEPA: arXiv:2507.19457 · AlphaEvolve: arXiv:2506.13131 · DGM: arXiv:2505.22954 · ShinkaEvolve: arXiv:2509.19349 · PromptBreeder: arXiv:2309.16797 · EvoPrompt: arXiv:2309.08532 · Reflexion: arXiv:2303.11366 · Self-correction critique: arXiv:2310.01798 · ExpeL: arXiv:2308.10144 · Voyager: arXiv:2305.16291 · AWM: arXiv:2409.07429 · Dynamic Cheatsheet: arXiv:2504.07952 · ACE: arXiv:2510.04618 · SE-Agent: arXiv:2508.02085 · ReasoningBank: arXiv:2509.25140 · Training-Free GRPO: arXiv:2510.08191 · FLEX: arXiv:2511.06449 · Memento: arXiv:2508.16153 · Memory Transfer Learning: arXiv:2604.14004 · UMEM: arXiv:2602.10652 · Surveys: arXiv:2507.21046, arXiv:2602.06052 · Misevolution: arXiv:2509.26354 · MemEvoBench: arXiv:2604.15774 · Signal and Noise in evaluation: arXiv:2508.13144.

**Ensembles and forecasting**
- Du et al.: arXiv:2305.14325 · Debate or Vote: arXiv:2508.17536 · Can LLM Agents Really Debate: arXiv:2511.07784 · MoA: arXiv:2406.04692 · Self-MoA: arXiv:2502.00674 · Silicon crowd: arXiv:2402.19379 · AIA Forecaster: arXiv:2511.07678 · Deliberating AI crowds: arXiv:2512.22625 · BLF: arXiv:2604.18576 · Pitfalls: arXiv:2506.00723 · Hindcast: arXiv:2607.14051 · Halawi et al.: arXiv:2402.18563 · Outcome-based RL forecasting: arXiv:2505.17989.

**Cascades and routing**
- FrugalGPT: arXiv:2305.05176 · RouteLLM: arXiv:2406.18665 · MoT cascade: arXiv:2310.03094 · AutoMix: arXiv:2310.12963 · ABC: arXiv:2407.02348 · Cascade routing: arXiv:2410.10347 · Token-level deferral: arXiv:2404.10136.

**Harness engineering (Anthropic)**
- https://www.anthropic.com/engineering/building-effective-agents · /multi-agent-research-system · /effective-context-engineering-for-ai-agents · /effective-harnesses-for-long-running-agents · /harness-design-long-running-apps · /demystifying-evals-for-ai-agents · https://claude.com/blog/building-agents-with-the-claude-agent-sdk · https://claude.com/blog/context-management ([S] numbers) · https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · https://code.claude.com/docs/en/memory.

**Items I could not verify or that are contested**
- Letta's default sleep-time frequency of 5.
- Karpathy's reported 11% time-to-GPT-2 gain and ~700 experiments (secondary sources only).
- Claude Code "skeptical memory" and autoDream (leak analyses only).
- Mem0's 2026 LongMemEval score of 94.4% (vendor claim).
- The LoCoMo numbers disputed between Zep and Mem0.
- The exact publication date of Anthropic's "Demystifying evals" post.
- ACE's deduplication threshold, which the paper does not publish.
