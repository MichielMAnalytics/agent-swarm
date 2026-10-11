# Dreaming

Dreaming is a nightly self-improvement loop for the whole swarm. Each active agent reports on its own last 24 hours. Lead reviews the reports against deterministic swarm data and approves a capped action list. Scripts then apply identity and memory actions, trim over-long profile fields, and prune Lead's HEARTBEAT. Every write is verified by re-reading the row, and every change keeps a pre-image so it can be rolled back.

It ships off. Turn it on in Settings → Configuration (Dreaming group) with `DREAMING_ENABLED=true`. The `dreaming-nightly` schedule triggers it; while dreaming is off, a run stops after `gather` and spends no tokens.

- **Dry run first.** Runs stay dry (no writes, no Slack post) until one dry run verifies green. Trigger with `{"dryRun": true}` to force a dry run at any time.
- **Lanes.** `DREAMING_LANE_HEARTBEAT`, `_TRIM`, `_IDENTITY` and `_MEMORY` switch each lane. A lane that is off spends no tokens.
- **Caps and budget.** `DREAMING_CAP_*` bound the actions per night. Over `DREAMING_BUDGET_USD`, the heartbeat draft is skipped and the report says so.
- **Report.** `DREAMING_REPORT_TARGET` is `page` (default), `agent-fs` or `none`. `DREAMING_SLACK_CHANNEL` adds a short Slack receipt on live runs.
- **Worker.** `DREAMING_WORKER_AGENT_ID` runs the trim, heartbeat draft and publish tasks. Empty means Lead.

Docs: https://docs.agent-swarm.dev/docs/guides/dreaming

The values live in config; the `input` map below only names them and their defaults.

```json
{
  "name": "dreaming",
  "description": "Nightly self-improvement loop. gather -> per-agent self-reports -> Lead synthesis -> apply identity and memory actions -> profile trims -> Lead HEARTBEAT prune -> verify -> learn -> owners -> report -> Slack. Off unless DREAMING_ENABLED is true; dry runs until one dry run verifies green.",
  "onNodeFailure": "continue",
  "cooldown": {
    "minutes": 60
  },
  "triggers": [],
  "input": {
    "enabled": "${DREAMING_ENABLED:-false}",
    "laneHeartbeat": "${DREAMING_LANE_HEARTBEAT:-true}",
    "laneTrim": "${DREAMING_LANE_TRIM:-true}",
    "laneIdentity": "${DREAMING_LANE_IDENTITY:-true}",
    "laneMemory": "${DREAMING_LANE_MEMORY:-true}",
    "slackChannel": "${DREAMING_SLACK_CHANNEL:-}",
    "reportTarget": "${DREAMING_REPORT_TARGET:-page}",
    "workerAgentId": "${DREAMING_WORKER_AGENT_ID:-}",
    "budgetUsd": "${DREAMING_BUDGET_USD:-25}",
    "capIdentityTotal": "${DREAMING_CAP_IDENTITY_TOTAL:-6}",
    "capIdentityPerAgent": "${DREAMING_CAP_IDENTITY_PER_AGENT:-1}",
    "capTrims": "${DREAMING_CAP_TRIMS:-3}",
    "capMemoryStore": "${DREAMING_CAP_MEMORY_STORE:-5}",
    "capMemoryEdit": "${DREAMING_CAP_MEMORY_EDIT:-5}",
    "capMemoryDelete": "${DREAMING_CAP_MEMORY_DELETE:-10}"
  },
  "nodes": [
    {
      "id": "gather",
      "type": "swarm-script",
      "label": "1. Deterministic gather and config (mode, lanes, caps)",
      "inputs": {
        "runId": "run.id"
      },
      "config": {
        "scriptName": "dream-gather",
        "scope": "global",
        "timeoutMs": 240000,
        "args": {
          "runId": "{{runId}}",
          "days": 1,
          "dryRun": "{{trigger.dryRun}}",
          "onlyAgentIds": "{{trigger.agentIds}}",
          "minTasks": 1,
          "enabled": "{{input.enabled}}",
          "laneHeartbeat": "{{input.laneHeartbeat}}",
          "laneTrim": "{{input.laneTrim}}",
          "laneIdentity": "{{input.laneIdentity}}",
          "laneMemory": "{{input.laneMemory}}",
          "slackChannel": "{{input.slackChannel}}",
          "reportTarget": "{{input.reportTarget}}",
          "workerAgentId": "{{input.workerAgentId}}",
          "budgetUsd": "{{input.budgetUsd}}",
          "capIdentityTotal": "{{input.capIdentityTotal}}",
          "capIdentityPerAgent": "{{input.capIdentityPerAgent}}",
          "capTrims": "{{input.capTrims}}",
          "capMemoryStore": "{{input.capMemoryStore}}",
          "capMemoryEdit": "{{input.capMemoryEdit}}",
          "capMemoryDelete": "{{input.capMemoryDelete}}"
        }
      },
      "next": "proceed"
    },
    {
      "id": "proceed",
      "type": "code-match",
      "label": "2. Enabled, a Lead, and active agents?",
      "config": {
        "code": "(input) => { const g = input.g; return (g && g.ok === true && g.mode !== 'off' && Array.isArray(g.agents) && g.agents.length > 0) ? 'go' : 'skip'; }",
        "outputPorts": [
          "go",
          "skip"
        ]
      },
      "inputs": {
        "g": "gather.result"
      },
      "next": {
        "go": "reports",
        "skip": "done"
      }
    },
    {
      "id": "reports",
      "type": "foreach",
      "label": "3. Per-agent self-report (Lead included)",
      "inputs": {
        "agents": "gather.result.agents",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun"
      },
      "config": {
        "over": "{{agents}}",
        "itemKey": "id",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{item.id}}",
            "modelTier": "regular",
            "tags": [
              "dreaming",
              "dreaming-report"
            ],
            "priority": 40,
            "template": "dreaming run {{runId}}: nightly self-report. DRY RUN = {{dryRun}}.\n\nYou are reporting on YOUR OWN last 24h of work so the swarm can improve itself tonight. This is a short, read-only task: target 10 tool calls or fewer. Do NOT call any write tool (no update-profile, memory-store/edit/delete, skill-*, script-upsert, slack-*, send-task). Proposals only; a separate step applies the approved ones and verifies them.\n\nYour deterministic evidence (task list, failures, skill invocations, memories you wrote, your profile sizes and exact H2 headings):\n{{item.evidence}}\n\nYou may open up to 3 of the listed tasks with get-task-details if a title is not enough. Your SOUL/IDENTITY/CLAUDE files are already in your system prompt; the exact H2 headings are in evidence.h2Anchors.\n\nYour agentId is {{item.id}}. Report on YOUR OWN work only; a report whose agentId is not exactly {{item.id}} is rejected.\n\nReturn ONLY a JSON object with these keys (arrays may be empty; an empty report is a valid, honest report):\n\n- agentId: your agent id.\n- summary: <= 300 chars, what you actually did and what went wrong, in plain words.\n- repeatedProcedures (max 3): a multi-step procedure you did 2+ times in the window, or once but you know it recurs. {what, occurrences, evidence:[taskIds], existingSkill: name of the skill that should have covered it, or \"\" if none, proposal: \"new-skill\" | \"extend-skill\"}.\n- skillFriction (max 3): a skill that was wrong, stale, missing a step, or that you did not find when you needed it. {skill, problem, fix, evidence:[taskIds]}.\n- scriptCandidates (max 2): deterministic steps you performed by hand with tool calls that a script could do (counts, lookups, SQL, API polling). {process, steps, perWeek, evidence:[taskIds]}.\n- identityOps (max 2): cleanup of YOUR OWN profile. Prefer removals and rewrites that make the file SHORTER: stale facts, dead hosts or tools, dated incident narrative, rules superseded by a skill, duplicates. {file: \"CLAUDE\"|\"IDENTITY\"|\"SOUL\"|\"TOOLS\"|\"HEARTBEAT\", op: \"remove-section\"|\"replace-section\"|\"append-under\"|\"replace-exact\", anchor: exact H2 line from evidence.h2Anchors (H2 ops), find: exact text that occurs ONCE in the file, >= 40 chars (replace-exact), content: new text (no \"## \" lines), reason, netChars: estimated size change}. Appends are allowed only on CLAUDE, <= 400 chars, and only for a call-time rule your evidence proves you needed. TOOLS is not in your system prompt; put call-time rules in CLAUDE. HEARTBEAT is Lead-only.\n- memoryOps (max 3): {op: \"store\"|\"edit\"|\"delete\", memoryIds:[...] (edit/delete), name: kebab-case key <= 90 chars, no newlines (store), content, reason, evidence:[taskIds or memoryIds]}. Store only a reusable lesson from tonight's evidence, and check memory-search first so you do not duplicate an existing memory. Delete only a memory you wrote that is now proven wrong.\n\nEvery item needs at least one evidence id from the evidence above or from a lookup you made. Items without evidence are dropped. Do not report other agents' problems unless they blocked your own task. Complete with store-progress status \"completed\" and output set to the JSON string.",
            "outputSchema": {
              "type": "object",
              "required": [
                "agentId",
                "summary",
                "repeatedProcedures",
                "skillFriction",
                "scriptCandidates",
                "identityOps",
                "memoryOps"
              ],
              "properties": {
                "agentId": {
                  "type": "string"
                },
                "summary": {
                  "type": "string"
                },
                "repeatedProcedures": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "what",
                      "evidence",
                      "proposal"
                    ],
                    "properties": {
                      "what": {
                        "type": "string"
                      },
                      "occurrences": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "existingSkill": {
                        "type": "string"
                      },
                      "proposal": {
                        "type": "string",
                        "enum": [
                          "new-skill",
                          "extend-skill"
                        ]
                      }
                    }
                  }
                },
                "skillFriction": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "skill",
                      "problem",
                      "evidence"
                    ],
                    "properties": {
                      "skill": {
                        "type": "string"
                      },
                      "problem": {
                        "type": "string"
                      },
                      "fix": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "scriptCandidates": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "process",
                      "evidence"
                    ],
                    "properties": {
                      "process": {
                        "type": "string"
                      },
                      "steps": {
                        "type": "string"
                      },
                      "perWeek": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "identityOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "file",
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "file": {
                        "type": "string",
                        "enum": [
                          "CLAUDE",
                          "IDENTITY",
                          "SOUL",
                          "TOOLS",
                          "HEARTBEAT"
                        ]
                      },
                      "op": {
                        "type": "string",
                        "enum": [
                          "remove-section",
                          "replace-section",
                          "append-under",
                          "replace-exact"
                        ]
                      },
                      "anchor": {
                        "type": "string"
                      },
                      "find": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "netChars": {
                        "type": "number"
                      }
                    }
                  }
                },
                "memoryOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "op": {
                        "type": "string",
                        "enum": [
                          "store",
                          "edit",
                          "delete"
                        ]
                      },
                      "memoryIds": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "name": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "next": "reports-check"
    },
    {
      "id": "reports-check",
      "type": "swarm-script",
      "label": "3b. Report guard: schema + slot match, pick retries",
      "inputs": {
        "agents": "gather.result.agents",
        "r": "reports.results"
      },
      "config": {
        "scriptName": "dream-reports-check",
        "scope": "global",
        "timeoutMs": 30000,
        "args": {
          "agents": "{{agents}}",
          "results": "{{r}}"
        }
      },
      "next": "reports-retry"
    },
    {
      "id": "reports-retry",
      "type": "foreach",
      "label": "3c. Retry failed/mismatched reports once, schema restated",
      "inputs": {
        "retry": "reports-check.result.retry",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun"
      },
      "config": {
        "over": "{{retry}}",
        "itemKey": "id",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{item.id}}",
            "modelTier": "regular",
            "tags": [
              "dreaming",
              "dreaming-report",
              "dreaming-report-retry"
            ],
            "priority": 40,
            "template": "dreaming run {{runId}}: RETRY of your nightly self-report. DRY RUN = {{dryRun}}.\n\nYour first report was rejected: {{item.firstFailure}}\nRead-only task, 8 tool calls or fewer, no write tools. Report on YOUR OWN last 24h only.\n\nYour agentId is {{item.id}}. The report's agentId MUST be exactly {{item.id}}.\nEvidence: {{item.evidence}}\n\nComplete with store-progress status \"completed\" and output set to ONE JSON object, no prose, no code fence, with EXACTLY these keys:\n{\"agentId\": \"{{item.id}}\", \"summary\": \"<= 300 chars\", \"repeatedProcedures\": [], \"skillFriction\": [], \"scriptCandidates\": [], \"identityOps\": [], \"memoryOps\": []}\nEvery key is required; each list key is a JSON array (empty is fine). Item shapes: repeatedProcedures {what, occurrences, evidence:[taskIds], existingSkill, proposal:\"new-skill\"|\"extend-skill\"}; skillFriction {skill, problem, fix, evidence}; scriptCandidates {process, steps, perWeek, evidence}; identityOps {file:\"CLAUDE\"|\"IDENTITY\"|\"SOUL\"|\"TOOLS\", op:\"remove-section\"|\"replace-section\"|\"append-under\"|\"replace-exact\", anchor, find, content, reason, netChars}; memoryOps {op:\"store\"|\"edit\"|\"delete\", memoryIds, name, content, reason, evidence}.\nAn empty report (all lists []) is valid and better than a late or invalid one.",
            "outputSchema": {
              "type": "object",
              "required": [
                "agentId",
                "summary",
                "repeatedProcedures",
                "skillFriction",
                "scriptCandidates",
                "identityOps",
                "memoryOps"
              ],
              "properties": {
                "agentId": {
                  "type": "string"
                },
                "summary": {
                  "type": "string"
                },
                "repeatedProcedures": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "what",
                      "evidence",
                      "proposal"
                    ],
                    "properties": {
                      "what": {
                        "type": "string"
                      },
                      "occurrences": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "existingSkill": {
                        "type": "string"
                      },
                      "proposal": {
                        "type": "string",
                        "enum": [
                          "new-skill",
                          "extend-skill"
                        ]
                      }
                    }
                  }
                },
                "skillFriction": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "skill",
                      "problem",
                      "evidence"
                    ],
                    "properties": {
                      "skill": {
                        "type": "string"
                      },
                      "problem": {
                        "type": "string"
                      },
                      "fix": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "scriptCandidates": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "process",
                      "evidence"
                    ],
                    "properties": {
                      "process": {
                        "type": "string"
                      },
                      "steps": {
                        "type": "string"
                      },
                      "perWeek": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "identityOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "file",
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "file": {
                        "type": "string",
                        "enum": [
                          "CLAUDE",
                          "IDENTITY",
                          "SOUL",
                          "TOOLS",
                          "HEARTBEAT"
                        ]
                      },
                      "op": {
                        "type": "string",
                        "enum": [
                          "remove-section",
                          "replace-section",
                          "append-under",
                          "replace-exact"
                        ]
                      },
                      "anchor": {
                        "type": "string"
                      },
                      "find": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "netChars": {
                        "type": "number"
                      }
                    }
                  }
                },
                "memoryOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "op": {
                        "type": "string",
                        "enum": [
                          "store",
                          "edit",
                          "delete"
                        ]
                      },
                      "memoryIds": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "name": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "next": "reports-merge"
    },
    {
      "id": "reports-merge",
      "type": "swarm-script",
      "label": "3d. Merge retries; still-invalid slots become missing reports",
      "inputs": {
        "agents": "gather.result.agents",
        "r": "reports.results",
        "rr": "reports-retry.results"
      },
      "config": {
        "scriptName": "dream-reports-check",
        "scope": "global",
        "timeoutMs": 30000,
        "args": {
          "agents": "{{agents}}",
          "results": "{{r}}",
          "retryResults": "{{rr}}"
        }
      },
      "next": "synthesize"
    },
    {
      "id": "synthesize",
      "type": "agent-task",
      "label": "4. Lead synthesis and critique",
      "inputs": {
        "g": "gather.result",
        "reports": "reports-merge.result.reports",
        "missing": "reports-merge.result.missing",
        "rejectedReports": "reports-merge.result.rejected",
        "runId": "run.id"
      },
      "config": {
        "agentId": "{{g.leadId}}",
        "modelTier": "smart",
        "tags": [
          "dreaming",
          "dreaming-synthesis"
        ],
        "priority": 50,
        "template": "dreaming run {{runId}}: synthesis and critique. DRY RUN = {{g.dryRun}}.\n\nYou are the reviewer, not the writer. Turn tonight's per-agent reports and the deterministic swarm data into an approved, capped action list, and record every rejection with a reason. Do NOT call write tools; approved actions are applied by later nodes (the apply script, the trim lane, the heartbeat lane) and verified by re-reading the rows.\n\nLanes switched on tonight (from config): {{g.lanes}}\nA lane set to false is OFF. Propose nothing for it, neither auto nor propose; list any item you drop for that reason in `rejected` with reason \"lane off\". identity = profile ops (identityOps on CLAUDE, IDENTITY, SOUL, TOOLS); heartbeat = Lead HEARTBEAT ops; memory = memory ops; trim = the profile-trim lane that runs after you (a net-positive identity op can only be auto when trim is on, see rule 2).\n\nPer-agent reports (foreach results; a child with status \"failed\" or a taskOutput starting \"[FAILED\" means that agent's report is missing, so note it and move on):\n{{reports}}\n\nReports rejected by the slot/schema guard (retried once): {{rejectedReports}}\nStill missing after the retry: {{missing}}\n\nDeterministic swarm data (audit results, skill usage, memory candidates):\n{{g.swarm}}\nAgents skipped for inactivity: {{g.skippedAgents}}\nGather errors (instrument gaps, NOT findings): {{g.errors}}\nCaps for tonight: {{g.caps}}\n\nLanes for actions:\n a skillify: a new skill, only for a procedure evidenced in 2+ tasks (or 2+ agents) and not covered by an existing skill. Check skill-search first.\n b skill-refactor: fix a stale/wrong skill body or description (from skillFriction or an audit), merge near-duplicates, or propose disabling a skill with 0 invocations in 14 days that a named skill supersedes.\n c scriptify: a deterministic process done by hand (scriptCandidates, repeated tool loops). Check script-search / the scripts catalog for an existing script first; if one exists, the action is \"wire it into skill X\", not \"write a new one\".\n d identity: the agents' own identityOps, plus at most 2 of your own for profiles the swarm data shows are clearly over-long (largest overage first). Lead HEARTBEAT ops are remove-only and belong to the heartbeat lane.\n e memory: the agents' memoryOps plus swarm.memory candidates: exact duplicates (keep the oldest row, delete the rest), unhelpful rows (edit or delete with a reason), badKeys (memory-rename, target.memoryIds + target.name kebab <= 90), and at most 3 new lessons from tonight's evidence.\n Skills and scripts have no writer in this workflow: skillify, skill-refactor and scriptify actions are always tier \"propose\", and the owners node sends each one to its owner.\n Profile trims are a separate lane (after apply): do not propose big rewrites here.\n\nRules for every action:\n1. Keep only evidence-backed items. Re-verify anything with an absence or state claim yourself (one db-query or gh call) before approving; say what you checked in `verified`.\n2. Tier \"auto\" only if it is inside the apply policy and its lane is on: identity ops that are net-negative, or CLAUDE appends <= 400 chars; a net-positive identity op may be auto too when the trim lane is on, because apply hands it to the trim lane, which writes it only inside a rewrite that leaves that file net-smaller tonight; memory store/edit/delete/rename within caps (a multi-chunk `manual` memory is deleted or renamed as a whole document; never task_completion/session_summary). Everything else is \"propose\".\n2b. Nothing stays parked: every action has `owner` (agent id). Auto actions are owned by their lane; for a propose action name who must decide it (the target agent for its own file, Lead for memory, skills and promotions, the agent that owns the code for code changes). The owners node sends each owner one task.\n3. Respect the caps; overflow goes to `rejected` with reason \"cap\".\n4. For H2 ops, copy the anchor verbatim from that agent's h2Anchors. For replace-exact, `find` must be text the agent quoted from its own file; you may shorten `content` but never invent an anchor.\n5. Dedup across agents: two agents proposing the same skill or memory become one action with both in sourceAgents.\n6. Every action gets an id \"A1\", \"A2\", ... that stays stable across all nodes.\n7. memory-edit: `content` is written verbatim as the memory's ENTIRE new body (default `mode: \"replace\"`), so a replace carries the full rewritten text. To add to a memory, set `mode: \"append\"` and put ONLY the new text in `content`; apply writes existing.trimEnd() + \"\\n\" + content. Never put instructions to the writer in `content` (\"APPEND to the end...\", \"keep everything above\", \"REPLACE the existing section...\"): apply refuses them. A replace that leaves under 50% of the old body is refused unless the action sets `allowShrink: \"<reason>\"`.\n\nLearning loop: {{g.learning}}\n- `recent` = the last 7 learn rows; `candidates` = cuts whose probe showed up in a failed task or a coaching reason in the last 24h; `pins` = text a lane must never cut again.\n- Emit up to 5 `restores: [{cutId, reason, evidence[]}]`, only for a candidate whose evidence shows the cut text was still needed (quote the evidence ids). Apply restores it and pins it.\n- Never propose removing pinned text.\nBudget: {{g.budget}}. If `overBudget` is true, propose no optional work beyond the caps.\n\nReturn ONLY JSON: {headline, actions[], rejected[], restores[], missingReports[], notes, changelogComment}. The headline is the single change tonight that will still matter next week, <= 140 chars, or \"quiet night\" if nothing qualifies. changelogComment: at most 2 sentences for the changelog: what changed tonight and what to watch tomorrow.",
        "outputSchema": {
          "type": "object",
          "required": [
            "headline",
            "actions",
            "rejected"
          ],
          "properties": {
            "headline": {
              "type": "string"
            },
            "actions": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "id",
                  "lane",
                  "tier",
                  "op",
                  "target",
                  "reason",
                  "evidence"
                ],
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "lane": {
                    "type": "string",
                    "enum": [
                      "skillify",
                      "skill-refactor",
                      "scriptify",
                      "identity",
                      "memory"
                    ]
                  },
                  "tier": {
                    "type": "string",
                    "enum": [
                      "auto",
                      "propose"
                    ]
                  },
                  "op": {
                    "type": "string",
                    "enum": [
                      "skill-create",
                      "skill-update",
                      "skill-disable",
                      "script-spec",
                      "remove-section",
                      "replace-section",
                      "append-under",
                      "replace-exact",
                      "memory-store",
                      "memory-edit",
                      "memory-delete",
                      "memory-rename",
                      "script-build"
                    ]
                  },
                  "target": {
                    "type": "object",
                    "properties": {
                      "agentId": {
                        "type": "string"
                      },
                      "file": {
                        "type": "string"
                      },
                      "anchor": {
                        "type": "string"
                      },
                      "find": {
                        "type": "string"
                      },
                      "memoryIds": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skillId": {
                        "type": "string"
                      },
                      "skillName": {
                        "type": "string"
                      },
                      "installFor": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "name": {
                        "type": "string"
                      },
                      "systemDefault": {
                        "type": "boolean"
                      }
                    }
                  },
                  "content": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  },
                  "verified": {
                    "type": "string"
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "sourceAgents": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "owner": {
                    "type": "string"
                  },
                  "mode": {
                    "type": "string",
                    "enum": [
                      "replace",
                      "append"
                    ],
                    "description": "memory-edit only. replace (default): content is the full new body. append: content is only the new text."
                  },
                  "allowShrink": {
                    "type": "string",
                    "description": "memory-edit replace only: the reason a body may shrink below 50%."
                  }
                }
              }
            },
            "rejected": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "from",
                  "item",
                  "reason"
                ],
                "properties": {
                  "from": {
                    "type": "string"
                  },
                  "item": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  }
                }
              }
            },
            "missingReports": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "notes": {
              "type": "string"
            },
            "changelogComment": {
              "type": "string"
            },
            "restores": {
              "type": "array",
              "maxItems": 5,
              "items": {
                "type": "object",
                "required": [
                  "cutId",
                  "reason"
                ],
                "properties": {
                  "cutId": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      },
      "retry": {
        "maxRetries": 1,
        "strategy": "exponential",
        "baseDelayMs": 1000,
        "maxDelayMs": 60000
      },
      "next": "apply"
    },
    {
      "id": "apply",
      "type": "swarm-script",
      "label": "5. Apply identity + memory (deterministic, lane-gated)",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "s": "synthesize.taskOutput"
      },
      "config": {
        "scriptName": "dream-apply",
        "scope": "global",
        "timeoutMs": 120000,
        "args": {
          "runId": "{{runId}}",
          "dryRun": "{{g.dryRun}}",
          "synth": "{{s}}",
          "caps": "{{g.caps}}",
          "lanes": "{{g.lanes}}"
        }
      },
      "next": "trim-plan"
    },
    {
      "id": "trim-plan",
      "type": "swarm-script",
      "label": "6. Trim plan: reverted, deferred edits, over-target, rotation",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "ap": "apply.result"
      },
      "config": {
        "scriptName": "dream-trim",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "plan",
          "runId": "{{runId}}",
          "dryRun": "{{g.dryRun}}",
          "deferred": "{{ap}}",
          "caps": "{{g.caps}}",
          "lanes": "{{g.lanes}}"
        }
      },
      "next": "trim"
    },
    {
      "id": "trim",
      "type": "foreach",
      "label": "6b. Draft one trimmed profile field per slot",
      "inputs": {
        "targets": "trim-plan.result.targets",
        "runId": "run.id",
        "g": "gather.result"
      },
      "config": {
        "over": "{{targets}}",
        "itemKey": "slot",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{g.workerId}}",
            "modelTier": "regular",
            "tags": [
              "dreaming",
              "dreaming-trim"
            ],
            "priority": 40,
            "template": "dreaming run {{runId}}: trim ONE profile field. DRY RUN = {{g.dryRun}}. The operator turned the trim lane on to keep agent profiles clean and clear, so a big trim is welcome when it keeps every behaviour rule. Nothing here is owed to a human.\n\nTarget: agent {{item.agentName}} ({{item.agentId}}), field {{item.field}} ({{item.file}}), now {{item.chars}} chars, sha256 {{item.sha256}}. Hard target: {{item.targetChars}} chars (empty = none; make it clean and clear). Why tonight: {{item.reason}}.\nNet-positive edits approved tonight that you MUST fold in verbatim: {{item.deferredEdits}}\n\n1. Read the field: db-query `SELECT {{item.field}} FROM agents WHERE id = '{{item.agentId}}'` (read it whole; page with substr() if the row is capped). The plan already stored its pre-image in KV (`{{item.preimageKey}}`, namespace `dreaming`), so you take no backup.\n2. Rewrite it. Keep: rules that change behaviour, call-time facts (agent ids, routing, hosts, exact commands), and every rule number other text cites (keep \"Rule #N\" labels stable; mark a retired number \"(retired)\" rather than renumbering). Cut: incident narratives, dated live-proof stories, frozen counts, duplicates, and anything a skill or tool description already carries (name the skill in a one-line pointer). A durable lesson you cut goes to movedToMemory (kebab name <= 90, swarm scope if workers need it) and leaves a one-line pointer `Memory <name>`. Keep the H2 structure readable. The result MUST be shorter than {{item.chars}} chars and, when a hard target is set, at most that target if you can do it without losing a behaviour rule.\n3. Write nothing: no update-profile, no memory-store, no file. Your output is the draft; the trim-apply script checks it against the live sha and the pre-image, writes the field, re-reads it and stores movedToMemory.\n\nComplete with store-progress status \"completed\" and output = ONE JSON object: {\"agentId\": \"{{item.agentId}}\", \"field\": \"{{item.field}}\", \"trimmed\": \"<the full new text>\", \"beforeChars\": {{item.chars}}, \"afterChars\": <n>, \"cut\": [\"<one line per removed block>\"], \"movedToMemory\": [{\"name\", \"content\", \"scope\"}], \"deferredApplied\": [\"<action ids>\"], \"notes\": \"\"}",
            "outputSchema": {
              "type": "object",
              "required": [
                "agentId",
                "field",
                "trimmed"
              ],
              "properties": {
                "agentId": {
                  "type": "string"
                },
                "field": {
                  "type": "string"
                },
                "trimmed": {
                  "type": "string"
                },
                "beforeChars": {
                  "type": "number"
                },
                "afterChars": {
                  "type": "number"
                },
                "cut": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "movedToMemory": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "name": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "scope": {
                        "type": "string"
                      }
                    }
                  }
                },
                "deferredApplied": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "notes": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "next": "trim-apply"
    },
    {
      "id": "trim-apply",
      "type": "swarm-script",
      "label": "6c. Trim apply: pre-image + sha check, net-smaller, write, re-read",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "tp": "trim-plan.result",
        "tr": "trim.results"
      },
      "config": {
        "scriptName": "dream-trim",
        "scope": "global",
        "timeoutMs": 120000,
        "args": {
          "mode": "apply",
          "runId": "{{runId}}",
          "dryRun": "{{g.dryRun}}",
          "plan": "{{tp}}",
          "drafts": "{{tr}}",
          "caps": "{{g.caps}}",
          "lanes": "{{g.lanes}}"
        }
      },
      "next": "hb-plan"
    },
    {
      "id": "hb-plan",
      "type": "swarm-script",
      "label": "7. Heartbeat lane: plan the Lead HEARTBEAT prune",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "ap": "apply.result"
      },
      "config": {
        "scriptName": "dream-heartbeat",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "plan",
          "runId": "{{runId}}",
          "leadId": "{{g.leadId}}",
          "dryRun": "{{g.dryRun}}",
          "apply": "{{ap}}",
          "lanes": "{{g.lanes}}"
        }
      },
      "next": "hb-draft-gate"
    },
    {
      "id": "hb-draft-gate",
      "type": "code-match",
      "label": "7b. Heartbeat lane: draft tonight?",
      "config": {
        "code": "(input) => { const g = input.g; const hp = input.hp; if (!g || !g.lanes || g.lanes.heartbeat !== true) return 'skip'; if (!hp || hp.ok !== true || hp.skipReason) return 'skip'; if (g.budget && g.budget.overBudget) return 'skip'; const t = hp.targets || {}; const c = hp.candidates || {}; const over = typeof hp.chars === 'number' && typeof t.maxChars === 'number' && hp.chars > t.maxChars; const work = (Array.isArray(c.remove) && c.remove.length > 0) || (Array.isArray(hp.deferredToHeartbeat) && hp.deferredToHeartbeat.length > 0) || (Array.isArray(hp.mustRestore) && hp.mustRestore.length > 0); return (over || work) ? 'draft' : 'skip'; }",
        "outputPorts": [
          "draft",
          "skip"
        ]
      },
      "inputs": {
        "hp": "hb-plan.result",
        "g": "gather.result"
      },
      "next": {
        "draft": "hb-draft",
        "skip": "hb-apply"
      }
    },
    {
      "id": "hb-draft",
      "type": "agent-task",
      "label": "7c. Heartbeat lane: draft the pruned HEARTBEAT (writes nothing)",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "hp": "hb-plan.result"
      },
      "config": {
        "agentId": "{{g.workerId}}",
        "modelTier": "regular",
        "tags": [
          "dreaming",
          "dreaming-heartbeat"
        ],
        "priority": 60,
        "template": "dreaming run {{runId}} ({{hp.mode}}), heartbeat lane: draft Lead's pruned HEARTBEAT. You write NO profile, heartbeat, memory or file outside /tmp. Your output is the draft: a script validates it and Lead's own session writes it. The operator turned this lane on to keep the heartbeat short and current, so big prunes and rewrites are welcome when they follow the rubric.\n\n## 1. Read the live text byte-exact (bash; MCP tool output can be truncated, so do not use it for this)\n```\nH=(-s -H \"Authorization: Bearer ${AGENT_SWARM_API_KEY:-$API_KEY}\" -H \"X-Agent-ID: $AGENT_ID\" -H \"Content-Type: application/json\")\ncurl \"${H[@]}\" -X POST \"$MCP_BASE_URL/api/scripts/run\" -d '{\"name\":\"dream-heartbeat\",\"scope\":\"global\",\"args\":{\"mode\":\"text\",\"leadId\":\"{{hp.leadId}}\"}}' > /tmp/hb-{{runId}}.json\njq -j .result.text /tmp/hb-{{runId}}.json > /tmp/hb-live-{{runId}}.md && sha256sum /tmp/hb-live-{{runId}}.md\n```\nThe sha must equal `{{hp.planSha}}`. If it does not, stop and return `{\"draft\":\"\",\"removed\":[],\"notes\":\"live changed since plan\"}`.\n\n## 2. Plan from hb-plan\n- targets: {{hp.targets}} (hard cap = `maxChars`)\n- sizes: tracked {{hp.tracked}}; standing orders {{hp.standingOrders}}\n- candidates: {{hp.candidates}}\n- pins (must keep verbatim if present): {{hp.pins}}\n- restores (re-insert each `line` that is not `present`, with `DELETE MM-DD` ≤14 days out unless it is 📌): {{hp.mustRestore}}\n- deferred removals from apply (must be gone from the draft): {{hp.deferredToHeartbeat}}\n- procedures-skill handshake: {{hp.handshake}}\n\n## 3. Rubric\nA fact lives in one place. The heartbeat keeps what Lead must DO each heartbeat and the live state of open work. Stories, proofs and procedure detail leave.\n1. **Validator rules (the server rejects the whole write otherwise).** Under the last `## Tracked Items` heading, every new or changed line must either keep the exact leading `**title**` of one old line, or be a pure deletion of characters from one old line (no new words), or start with `📌`, or carry `DELETE MM-DD` (≤14 days out). One old line can cover only one new line. Never drop a `DELETE MM-DD` or a `📌` from a line you keep. Keep `## Tracked Items` as the last heading with that text.\n2. **📌 lines stay byte-for-byte**, everywhere in the file. So do `Rule #N` labels (or mark one `(retired)` with a reason).\n3. **Tracked Items: ≤{{hp.targets.trackedItemsChars}} chars, each item ≤{{hp.targets.itemChars}} chars.** Remove every `candidates.remove` item. Remove `candidates.review` and `closedUndated` items unless the line holds an open next action. Compress every other item to: `**title**` (exact), status, the next action, one pointer (task id, PR or memory name).\n4. **Standing Orders: ≤{{hp.targets.standingOrdersChars}} chars.** Keep each rule as one or two imperative lines. Delete dated incident stories, \"proven on X\" evidence, repeated rationale and frozen counts; leave `Memory <name>` as the pointer when one exists. Procedure detail (how-to steps) may be cut only when its probe is in `handshake.ready`; otherwise compress it in place and also propose it in `runbookAdds` for the `{{hp.runbookSkill}}` skill (never `heartbeat-runbook`, which is locked).\n5. **Everything else** (header, Governance, Infra watch, Reference): keep the substance, compress the prose.\n6. Text worth keeping that fits nowhere: `movedToMemory` (≤10 new memories, name `^[a-z0-9-]{3,90}$`, self-contained content).\n\n## 4. Draft and pre-check\n1. Write the draft to `/tmp/hb-draft-{{runId}}.md` (your own container; Lead's disk is untouched) and your `removed[]` array to `/tmp/hb-removed-{{runId}}.json`.\n2. Pre-check it with the same checks `hb-check` runs (validator port, 📌 set, size, removed coverage). This stages a scratch copy that `hb-check` later overwrites with the draft you return:\n```\njq -n --rawfile t /tmp/hb-draft-{{runId}}.md --slurpfile r /tmp/hb-removed-{{runId}}.json '{name:\"dream-heartbeat\",scope:\"global\",args:{mode:\"check\",runId:\"{{runId}}\",leadId:\"{{hp.leadId}}\",dryRun:true,plan:{planSha:\"{{hp.planSha}}\",targets:{maxChars:{{hp.targets.maxChars}}}},draft:{draft:$t,removed:$r[0]}}}' | curl \"${H[@]}\" -X POST \"$MCP_BASE_URL/api/scripts/run\" -d @- | jq -c '.result | {ready,reasons,stats,draftSha}'\nsha256sum /tmp/hb-draft-{{runId}}.md\n```\n`ready` must be true. Otherwise fix the draft and re-check.\n\n## 5. Return JSON only\nBuild the output with jq from the files so the draft stays byte-exact, and pass that JSON verbatim as the store-progress output:\n```\njq -n --rawfile d /tmp/hb-draft-{{runId}}.md --slurpfile r /tmp/hb-removed-{{runId}}.json --arg s \"$(sha256sum /tmp/hb-draft-{{runId}}.md | cut -d' ' -f1)\" '{draft:$d, draftSha:$s, chars:($d|length), removed:$r[0], compressed:[], movedToMemory:[], runbookAdds:[], notes:\"\"}' > /tmp/hb-out-{{runId}}.json\n```\nFill `compressed`, `movedToMemory` and `runbookAdds` before you return. Shapes:\n```\n{\"draft\":\"<the full draft text>\",\"draftSha\":\"<sha256 of the draft>\",\"chars\":<n>,\n \"removed\":[{\"title\":\"<exact text inside the item's **…**, or null>\",\"probe\":\"<≤80 chars: first 60 chars of the removed line (no bullet), or a distinctive phrase of a removed Standing Orders block>\",\"reason\":\"<due|closed|stale|story|duplicate|moved-to-memory|moved-to-runbook|compressed-away>\",\"movedTo\":\"memory|runbook|none\"}],\n \"compressed\":[{\"title\":\"…\",\"fromChars\":n,\"toChars\":n}],\n \"movedToMemory\":[{\"name\":\"…\",\"content\":\"…\"}],\n \"runbookAdds\":[{\"probe\":\"<≤80-char phrase that will appear in the skill>\",\"text\":\"<procedure text>\",\"fromSection\":\"### …\"}],\n \"notes\":\"\"}\n```\nEvery tracked item that is gone from the draft needs a `removed[]` entry whose `title` (or `probe`) matches it. `hb-check` refuses the draft otherwise, and it refuses a `draftSha` that does not match `draft`.",
        "outputSchema": {
          "type": "object",
          "required": [
            "draft",
            "removed"
          ],
          "properties": {
            "draft": {
              "type": "string"
            },
            "draftSha": {
              "type": "string"
            },
            "chars": {
              "type": "number"
            },
            "removed": {
              "type": "array"
            },
            "compressed": {
              "type": "array"
            },
            "movedToMemory": {
              "type": "array"
            },
            "runbookAdds": {
              "type": "array"
            },
            "notes": {
              "type": "string"
            }
          }
        }
      },
      "next": "hb-check"
    },
    {
      "id": "hb-check",
      "type": "swarm-script",
      "label": "7d. Heartbeat lane: stage the draft in KV, validate it, wait for a quiet window",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "hp": "hb-plan.result",
        "hd": "hb-draft.taskOutput"
      },
      "config": {
        "scriptName": "dream-heartbeat",
        "scope": "global",
        "timeoutMs": 300000,
        "args": {
          "mode": "check",
          "runId": "{{runId}}",
          "leadId": "{{g.leadId}}",
          "dryRun": "{{g.dryRun}}",
          "plan": "{{hp}}",
          "draft": "{{hd}}"
        }
      },
      "next": "hb-gate"
    },
    {
      "id": "hb-gate",
      "type": "code-match",
      "label": "7e. Heartbeat lane: run lead-disk?",
      "config": {
        "code": "(input) => (input.g && input.g.lanes && input.g.lanes.heartbeat === true && input.c && input.c.ready === true) ? 'run' : 'skip'",
        "outputPorts": [
          "run",
          "skip"
        ]
      },
      "inputs": {
        "c": "hb-check.result",
        "g": "gather.result"
      },
      "next": {
        "run": "lead-disk",
        "skip": "hb-apply"
      }
    },
    {
      "id": "lead-disk",
      "type": "agent-task",
      "label": "7f. Heartbeat lane: Lead writes its own disk copy (backup, sha checks, quiet window, atomic mv)",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "hp": "hb-plan.result",
        "hc": "hb-check.result"
      },
      "config": {
        "agentId": "{{g.leadId}}",
        "modelTier": "regular",
        "tags": [
          "dreaming",
          "dreaming-heartbeat",
          "lead-disk"
        ],
        "priority": 70,
        "template": "dreaming run {{runId}}, `lead-disk`, MODE = {{hc.diskMode}}. You are the only step that touches your own disk copy of a profile field. Tonight's field: heartbeatMd → `/workspace/HEARTBEAT.md`.\n\nRules: Bash only, plus the one kv-get call in step 3. Do NOT use Write, Edit or MultiEdit on these files: a Write posts a half state through self_edit. At most 6 bash calls. Do not \"fix\" anything you find; report it.\n\nValues: plan sha `{{hp.planSha}}` · draft in KV namespace `dreaming`, key `hb-draft:{{runId}}` · draft sha `{{hc.draftSha}}`.\n\n1. `sha256sum /workspace/HEARTBEAT.md` must equal the plan sha. If it does not, stop and return `stopReason: \"disk-drift\"` with the sha you saw. Leave the file as it is.\n2. Back up the disk file before anything writes it: `mkdir -p /workspace/personal/heartbeat-backups && cp /workspace/HEARTBEAT.md /workspace/personal/heartbeat-backups/{{runId}}.md && sha256sum /workspace/personal/heartbeat-backups/{{runId}}.md`. The backup sha must equal the plan sha.\n3. Read the draft: call kv-get with namespace `dreaming` and key `hb-draft:{{runId}}`. The value is `{text, sha, at}`, and `sha` must equal the draft sha, else stop with `stopReason: \"draft-sha-mismatch\"`. Tool output is not byte-safe, so copy the text to disk with the REST form of the same read:\n```\ncurl -s -H \"Authorization: Bearer ${AGENT_SWARM_API_KEY:-$API_KEY}\" -H \"X-Agent-ID: $AGENT_ID\" \"$MCP_BASE_URL/api/kv/_/dreaming/hb-draft:{{runId}}\" | jq -j .value.text > /tmp/hb-{{runId}}.md && sha256sum /tmp/hb-{{runId}}.md\n```\n   The file sha must equal the draft sha, else stop with `stopReason: \"draft-sha-mismatch\"`.\n4. Both modes: run this ONE bash call exactly as written. Do not split it, edit it, retry it, or run cp yourself. It asks the swarm whether a Lead heartbeat-checklist task is live (pending or in progress), re-checks the disk sha against the plan sha, and only in MODE live copies the draft through a temp file and mv:\n```\nM={{hc.diskMode}}; H=/workspace/HEARTBEAT.md; T=/workspace/.HEARTBEAT.md.{{runId}}.tmp; Q=$(curl -s -m 30 -X POST \"$MCP_BASE_URL/api/scripts/run\" -H \"Authorization: Bearer ${AGENT_SWARM_API_KEY:-$API_KEY}\" -H \"X-Agent-ID: $AGENT_ID\" -H \"Content-Type: application/json\" -d '{\"name\":\"dream-heartbeat\",\"scope\":\"global\",\"args\":{\"mode\":\"quiet\",\"leadId\":\"{{hp.leadId}}\"}}' | jq -r 'if .result.quiet == true then \"quiet\" else \"busy:\" + ((.result.busy // []) | map(.id[0:8] + \"/\" + .status) | join(\",\")) + (.error // \"\" | tostring) end' 2>/dev/null); S=$(sha256sum \"$H\" | cut -d' ' -f1); if [ \"$Q\" != quiet ]; then echo \"STOP heartbeat-busy ${Q:-no-answer} $S\"; elif [ \"$S\" != \"{{hp.planSha}}\" ]; then echo \"STOP disk-drift $S\"; elif [ \"$M\" != live ]; then echo \"WOULD-WRITE $S\"; else cp /tmp/hb-{{runId}}.md \"$T\" && mv -f \"$T\" \"$H\" && echo \"WROTE $(sha256sum \"$H\" | cut -d' ' -f1)\"; fi\n```\n   Its output line goes into `copyGuard` verbatim. `WROTE <sha>`: `diskAfterSha` = that sha, which must equal the draft sha. `WOULD-WRITE <sha>` (dry): `diskAfterSha` null. `STOP heartbeat-busy ...`: stop, `stopReason: \"heartbeat-busy\"`, `diskAfterSha` null. `STOP disk-drift <sha>`: stop, `stopReason: \"disk-drift\"`, `diskAfterSha` null.\n\nReturn ONLY JSON:\n{\"mode\":\"dry|live\",\"fields\":[{\"field\":\"heartbeatMd\",\"diskPath\":\"/workspace/HEARTBEAT.md\",\"diskBeforeSha\":\"<step 1>\",\"backupPath\":\"/workspace/personal/heartbeat-backups/{{runId}}.md\",\"backupSha\":\"<step 2>\",\"draftShaOk\":<true|false>,\"copyGuard\":\"<step 4 output line, or null if you stopped before step 4>\",\"diskAfterSha\":<\"<step 4 WROTE sha>\" or null>,\"stopReason\":<null|\"disk-drift\"|\"draft-sha-mismatch\"|\"heartbeat-busy\">}]}",
        "outputSchema": {
          "type": "object",
          "required": [
            "mode",
            "fields"
          ],
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "dry",
                "live"
              ]
            },
            "fields": {
              "type": "array"
            }
          }
        }
      },
      "next": "hb-apply"
    },
    {
      "id": "hb-apply",
      "type": "swarm-script",
      "label": "7g. Heartbeat lane: DB write after the disk (live only), else wouldApply",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "hp": "hb-plan.result",
        "hc": "hb-check.result",
        "hd": "hb-draft.taskOutput",
        "ld": "lead-disk.taskOutput"
      },
      "config": {
        "scriptName": "dream-heartbeat",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "apply",
          "runId": "{{runId}}",
          "leadId": "{{g.leadId}}",
          "dryRun": "{{g.dryRun}}",
          "plan": "{{hp}}",
          "check": "{{hc}}",
          "draft": "{{hd}}",
          "disk": "{{ld}}"
        }
      },
      "next": "verify"
    },
    {
      "id": "verify",
      "type": "swarm-script",
      "label": "8. Verify claims, unclaimed writes, survival, ledger",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "s": "synthesize.taskOutput",
        "ap": "apply.result",
        "tr": "trim-apply.result",
        "hba": "hb-apply.result"
      },
      "config": {
        "scriptName": "dream-verify",
        "scope": "global",
        "timeoutMs": 180000,
        "args": {
          "runId": "{{runId}}",
          "leadId": "{{g.leadId}}",
          "dryRun": "{{g.dryRun}}",
          "since": "{{g.generatedAt}}",
          "synth": "{{s}}",
          "apply": "{{ap}}",
          "trim": "{{tr}}",
          "wfSnapshot": "{{g.workflowSnapshot}}",
          "hb": "{{hba}}"
        }
      },
      "next": "learn"
    },
    {
      "id": "learn",
      "type": "swarm-script",
      "label": "9. Learning loop: score cuts, pins, per-lane metrics",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "tr": "trim-apply.result",
        "hba": "hb-apply.result"
      },
      "config": {
        "scriptName": "dream-learn",
        "scope": "global",
        "timeoutMs": 120000,
        "args": {
          "runId": "{{runId}}",
          "leadId": "{{g.leadId}}",
          "dryRun": "{{g.dryRun}}",
          "trim": "{{tr}}",
          "hb": "{{hba}}",
          "budget": "{{g.budget}}"
        }
      },
      "next": "owners"
    },
    {
      "id": "owners",
      "type": "swarm-script",
      "label": "10. Owners: one task per owner for everything no lane closed",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "s": "synthesize.taskOutput",
        "ap": "apply.result",
        "tr": "trim-apply.result"
      },
      "config": {
        "scriptName": "dream-owners",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "runId": "{{runId}}",
          "leadId": "{{g.leadId}}",
          "workerId": "{{g.workerId}}",
          "dryRun": "{{g.dryRun}}",
          "synth": "{{s}}",
          "apply": "{{ap}}",
          "trim": "{{tr}}"
        }
      },
      "next": "publish"
    },
    {
      "id": "publish",
      "type": "agent-task",
      "label": "11. Publish the report (page, agent-fs or none) and the Slack text",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "s": "synthesize.taskOutput",
        "v": "verify.result",
        "reports": "reports.results",
        "tr": "trim-apply.result",
        "tp": "trim-plan.result",
        "ow": "owners.result",
        "rm": "reports-merge.result",
        "lr": "learn.result",
        "ap": "apply.result",
        "hbc": "hb-check.result",
        "hba": "hb-apply.result",
        "ld": "lead-disk.taskOutput"
      },
      "config": {
        "agentId": "{{g.workerId}}",
        "modelTier": "regular",
        "tags": [
          "dreaming",
          "dreaming-publish"
        ],
        "priority": 50,
        "template": "dreaming run {{runId}}: publish the nightly report. Mode {{g.mode}}, DRY RUN = {{g.dryRun}}, report target `{{g.cfg.reportTarget}}`.\n\nInputs: gather {{g}} | synthesis {{s}} | verify {{v}} | trim plan {{tp}} | trim apply {{tr}} | owners {{ow}} | report guard {{rm}} | reports {{reports}} | learn {{lr}} | apply (restores/wouldRestore/restoreRefused in) {{ap}} | heartbeat check {{hbc}} | lead-disk {{ld}} | heartbeat apply {{hba}}\n(Empty strings mean a failed or skipped node, or a lane that is off: say which, from gather.lanes.)\n\nUNITS: state every size (file, field, profile, heartbeat, draft, prompt, or a size delta) in tokens: tokens = ceil(chars / 4 * ratio), ratio = 1 (uncalibrated). A signed char delta d becomes sign(d) * ceil(|d| / 4 * ratio). Inputs arrive in chars (beforeChars, afterChars, chars, liveChars, draftChars, trimmedChars, netChars, profileChars, heartbeatChars, backlog sizes, identity/memory op deltas): convert when you print and write `<n> tok`. Compute every converted value with one python3 -c or bun -e call over the input numbers, never by hand. Keep a char value only where the limit itself counts chars, in parentheses after the tokens. Counts that are not sizes stay as they are (pins, tracked items, cuts, memories, actions, USD, seconds, minutes). The 450-char slackText limit below is a Slack length limit, not a size you report.\n\n1. Report (Markdown). On a dry run, open with: \"Dry run: nothing below was written; it is what a live run would do.\"\n   If gather.overlap is non-empty, add right after that: \"Overlap: <names> also edits memories and profiles every day. Disable it, so the two loops do not edit the same rows and verify does not count its writes as unclaimed.\"\n   Sections: Headline; Silent refusals / claim mismatches / unclaimed writes / reverted trims (verify, trim survival) FIRST if non-empty; Applied (verify-confirmed only) per lane with target, one-line why, action id; Trims: one row per field (agent, field, before -> after tokens, pre-image key, and its one-line revert command from trim apply `revert`), plus refused trims with reasons and the backlog; Owned items (owners: owner, action ids, task id; say so when owners is `degraded`); Rejected (count + top reasons); Report guard (rejected/retried/missing); Lanes (one line: each lane from gather.lanes, on or off); Instrument gaps (gather errors and the line `Sizes in tokens = ceil(chars / 4 * 1), ratio 1 uncalibrated.`); Cost and runtime per node (verify.metrics).\n   **Learning**: paste `learn.table` (tonight, delta, 7-night mean) verbatim except its char rows: `profileChars` and `heartbeatChars` become `profileTokens` and `heartbeatTokens` with every number converted, then reverted / reintroduced / referenced cuts and new pins (learn.scored, learn.newPins), then restores (apply restores, wouldRestore, restoreRefused). **Heartbeat**: hb-check ready + reasons + stats (tokens before -> after, pins before = after, removed), lead-disk mode and shas, hb-apply status (wouldApply on a dry run). **Profiles**: learn.metrics.laneA totals, sizes in tokens.\n   A lane's claim without verify confirmation goes under \"Unverified\".\n2. Where the report goes, by report target (dry runs publish too: that is how an operator reviews a dry run before the first live night):\n   - `page`: create_page with title `dreaming/<UTC date>`, slug `dreaming-<UTC date>`, contentType `text/html`, authMode `authed` (never public), the report rendered as one plain HTML document. Return its URL in `reportUrl`. If create_page is not available to you, return the report in `markdown` and say so in `notes`.\n   - `agent-fs`: in your default org and drive, write `dreaming/runs/<UTC date>.md`, then append ONE entry to `dreaming/changelog.md` with `agent-fs append` (never write or overwrite that file; people comment in it). Dry runs skip the changelog append and return the entry in `changelogEntry`. Return the report path in `reportPath`.\n   - `none`: publish nothing; return the report in `markdown` only.\n   Changelog entry format, exactly:\n   ## <YYYY-MM-DD>: night <gather.night.number>\n   - Run <runId>, <mode>, <status: green | degraded (why)>, cost so far $<verify.metrics.totalCostSoFarUsd>; previous run full cost $<gather.budget.prevRunUsd> vs budget $<gather.cfg.budgetUsd>\n   - Learning: profiles <tokens of learn.trend.profileChars.tonight> tok (Δ <delta in tok>), heartbeat <tokens of learn.trend.heartbeatChars.tonight> tok (Δ <delta in tok>), restores <n applied or would-restore>\n   - <n> applied, <n> proposed, <n> rejected: <synthesis headline>\n   - Trims: <trimsLine, without the 'Trims:' prefix>\n   - Workflow changes since last run: <gather.workflowChanges: added/removed/config-changed node ids, with its base; \"none\" if all three are empty>\n   - **Lead:** <synthesis changelogComment>\n3. slackText: at most 3 lines, no headers. The Slack node appends `trimsLine` as line 4, so the receipt is at most 4 lines:\n   line 1 \":crescent_moon: Dreaming <date><' (dry run)' on a dry run>: <headline> · <n> applied (<per-lane counts, only non-zero>), <n> proposed, <n> rejected\"\n   line 2 only if verify found a silent refusal, claim mismatch, unclaimed write, survival.reverted item or reverted trim, or gather.overlap is non-empty: \":warning: <one line>\". survival.trimmed and survival.drifted are expected later rewrites: never warn on them.\n   last line: the report link (`reportUrl` or `reportPath`), or \"no report (target none)\".\n   Never put a newline inside a line. The trims line is added by the Slack node; do not repeat it. Keep slackText under 450 chars.\n4. trimsLine: trim apply `slackLine` with each `<before>→<after>` char pair rewritten in tokens and ` tok` after it, wording and order otherwise unchanged, e.g. `Lead claudeMd 17263→15903` -> `Lead claudeMd 4316→3976 tok`. Build it with code (regex over slackLine, values from trim apply wouldApply/applied beforeChars/afterChars). One line, no newline; empty string when trim apply is empty.\n\nReturn ONLY JSON {reportTarget, reportPath, reportUrl, slackText, trimsLine, markdown, changelogEntry, changelogAppended, notes}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "slackText"
          ],
          "properties": {
            "reportTarget": {
              "type": "string"
            },
            "reportPath": {
              "type": "string"
            },
            "reportUrl": {
              "type": "string"
            },
            "slackText": {
              "type": "string"
            },
            "trimsLine": {
              "type": "string"
            },
            "markdown": {
              "type": "string"
            },
            "changelogEntry": {
              "type": "string"
            },
            "changelogAppended": {
              "type": "boolean"
            },
            "notes": {
              "type": "string"
            }
          }
        }
      },
      "next": "slack-gate"
    },
    {
      "id": "slack-gate",
      "type": "code-match",
      "label": "12. Post to Slack? (live runs with a channel only)",
      "config": {
        "code": "(input) => { const g = input.g; const p = input.p; const ch = g && g.cfg && typeof g.cfg.slackChannel === 'string' ? g.cfg.slackChannel.trim() : ''; return (g && g.dryRun === false && ch.length > 0 && p && typeof p === 'object' && typeof p.slackText === 'string' && p.slackText.length > 0) ? 'post' : 'skip'; }",
        "outputPorts": [
          "post",
          "skip"
        ]
      },
      "inputs": {
        "p": "publish.taskOutput",
        "g": "gather.result"
      },
      "next": {
        "post": "slack",
        "skip": "done"
      }
    },
    {
      "id": "slack",
      "type": "notify",
      "label": "13. Slack receipt",
      "inputs": {
        "p": "publish.taskOutput",
        "g": "gather.result"
      },
      "config": {
        "channel": "slack",
        "target": "{{g.cfg.slackChannel}}",
        "template": "{{p.slackText}}\n{{p.trimsLine}}"
      }
    },
    {
      "id": "done",
      "type": "code-match",
      "label": "done (off, quiet, or no Slack post)",
      "config": {
        "code": "() => 'done'",
        "outputPorts": [
          "done"
        ]
      }
    }
  ]
}
```
