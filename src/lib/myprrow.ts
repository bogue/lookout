import type { CiState, MyPr, PrColumn, ReviewFlavor } from '../types'

// The `my_prs` table row, exactly as the schema defines it (src-tauri/migrations/013_my_prs.sql).
// Shared so the two drivers that read this table agree on its shape: the app (tauri-plugin-sql) and
// the CLI (node:sqlite). Change the schema and both sides fail to compile together.
export type MyPrRow = {
  id: string
  repo: string
  repo_path: string | null
  number: number
  title: string
  url: string
  branch: string
  pr_created_at: string
  state: string
  is_draft: number
  human_review: string | null
  bot_review: string | null
  ci_state: string | null
  derived_column: string
  board_column: string
  sort_order: number | null
  done_at: string | null
  updated_at: string
}

export const rowToMyPr = (r: MyPrRow): MyPr => ({
  id: r.id,
  repo: r.repo,
  repoPath: r.repo_path,
  number: r.number,
  title: r.title,
  url: r.url,
  branch: r.branch,
  createdAt: r.pr_created_at,
  state: r.state as MyPr['state'],
  isDraft: r.is_draft === 1,
  humanReview: r.human_review as ReviewFlavor,
  botReview: r.bot_review as ReviewFlavor,
  ciState: r.ci_state as CiState,
  derivedColumn: r.derived_column as PrColumn,
  column: r.board_column as PrColumn,
  sortOrder: r.sort_order,
  doneAt: r.done_at,
})
