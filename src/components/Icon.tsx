import {
  AlertIcon,
  ChatIcon,
  CheckCircleFillIcon,
  CheckCircleIcon,
  ChecklistIcon,
  CodeReviewIcon,
  CommentDiscussionIcon,
  CommentIcon,
  DependabotIcon,
  EyeIcon,
  FileDiffIcon,
  FileIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  IssueReopenedIcon,
  type Icon as OcticonType,
  PaperAirplaneIcon,
  RepoPushIcon,
  StopIcon,
  SyncIcon,
  WorkflowIcon,
  XCircleIcon,
} from '@primer/octicons-react'
import type { IconName } from '../lib/icons'

const OCTICONS: Record<IconName, OcticonType> = {
  alert: AlertIcon,
  chat: ChatIcon,
  'check-circle': CheckCircleIcon,
  'check-circle-fill': CheckCircleFillIcon,
  checklist: ChecklistIcon,
  'code-review': CodeReviewIcon,
  comment: CommentIcon,
  'comment-discussion': CommentDiscussionIcon,
  dependabot: DependabotIcon,
  eye: EyeIcon,
  file: FileIcon,
  'file-diff': FileDiffIcon,
  'git-commit': GitCommitIcon,
  'git-merge': GitMergeIcon,
  'git-pull-request': GitPullRequestIcon,
  'git-pull-request-closed': GitPullRequestClosedIcon,
  'issue-reopened': IssueReopenedIcon,
  'paper-airplane': PaperAirplaneIcon,
  'repo-push': RepoPushIcon,
  stop: StopIcon,
  sync: SyncIcon,
  workflow: WorkflowIcon,
  'x-circle': XCircleIcon,
}

// the color a glyph always means (GitHub's: merged is purple, closed red…); the rest takes the text's
const TONE: Partial<Record<IconName, string>> = {
  alert: 'text-amber-400',
  'check-circle': 'text-grass-400',
  'check-circle-fill': 'text-grass-400',
  'file-diff': 'text-red-400',
  'git-merge': 'text-purple-400',
  'git-pull-request': 'text-grass-400',
  'git-pull-request-closed': 'text-red-400',
  stop: 'text-red-400',
  'x-circle': 'text-red-400',
}

// An Octicon sitting in a line of text: vertically centred on it, 14px unless told otherwise
export const Icon = ({ name, size = 14, className = '' }: { name: IconName; size?: number; className?: string }) => {
  const Octicon = OCTICONS[name]
  return <Octicon size={size} className={`inline-block shrink-0 align-[-2px] ${TONE[name] ?? ''} ${className}`} />
}

// the box's tint, in the glyph's color; the rest sits in a neutral box
const BOX_TONE: Partial<Record<IconName, string>> = {
  alert: 'border-amber-500/40 bg-amber-500/15',
  'check-circle': 'border-grass-500/40 bg-grass-500/15',
  'check-circle-fill': 'border-grass-500/40 bg-grass-500/15',
  'file-diff': 'border-red-500/40 bg-red-500/15',
  'git-merge': 'border-purple-500/40 bg-purple-500/15',
  'git-pull-request': 'border-grass-500/40 bg-grass-500/15',
  'git-pull-request-closed': 'border-red-500/40 bg-red-500/15',
  stop: 'border-red-500/40 bg-red-500/15',
  'x-circle': 'border-red-500/40 bg-red-500/15',
}

// GitHub's timeline badge: the icon in a small circle tinted by what happened. As tall as the line
// it sits in (20px in a bubble, 16px in a quote) and top-aligned, so it centres on the text exactly —
// align-middle centres on the x-height and sits a pixel or two low.
export const IconBox = ({
  name,
  small = false,
  className = '',
}: {
  name: IconName
  small?: boolean
  className?: string
}) => (
  <span
    className={`inline-flex shrink-0 items-center justify-center rounded-full border align-top ${small ? 'size-4' : 'size-5'} ${
      BOX_TONE[name] ?? 'border-deck-600 bg-deck-700 text-deck-300'
    } ${className}`}
  >
    <Icon name={name} size={small ? 10 : 12} />
  </span>
)
