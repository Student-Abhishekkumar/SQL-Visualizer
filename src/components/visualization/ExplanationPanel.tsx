import { useState } from 'react'
import { BookOpen, CheckCircle2, ChevronDown, ExternalLink, XCircle } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import {
  explainStage,
  knowledgeCheckFor,
  LEARNING_LEVELS,
  type LearningLevel,
  docsForStage,
} from '../../services/visualization/explanations'
import type { StageSnapshot, VisualizedStage } from '../../types/visualization'

/**
 * Right panel: dynamic explanation of the current stage — concept at
 * the selected learning level, what actually happened (from the real
 * snapshot data), trusted documentation links and an optional
 * knowledge check.
 */

interface ExplanationPanelProps {
  stage: VisualizedStage | null
  snapshot: StageSnapshot | null
}

function KnowledgeCheckSection({
  stage,
  level,
}: {
  stage: VisualizedStage
  level: LearningLevel
}) {
  const check = knowledgeCheckFor(stage, level)
  const [selected, setSelected] = useState<number | null>(null)
  const [answeredFor, setAnsweredFor] = useState<VisualizedStage | null>(null)

  if (check === null) return null

  // Reset the answer when the question changes.
  if (answeredFor !== stage) {
    setAnsweredFor(stage)
    setSelected(null)
  }

  const answered = selected !== null

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">
        Knowledge check
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-text-primary">{check.question}</p>
      <div className="mt-2 space-y-1">
        {check.options.map((option, index) => {
          const isCorrect = index === check.correctIndex
          const isSelected = selected === index
          let style = 'border-border hover:border-border-strong hover:bg-surface-3'
          if (answered && isCorrect) style = 'border-success/50 bg-success/10 text-text-primary'
          else if (answered && isSelected && !isCorrect) style = 'border-danger/50 bg-danger-soft'
          else if (answered) style = 'border-border opacity-60'
          return (
            <button
              key={option}
              type="button"
              disabled={answered}
              onClick={() => setSelected(index)}
              className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${style}`}
            >
              <span>{option}</span>
              {answered && isCorrect && (
                <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
              )}
              {answered && isSelected && !isCorrect && (
                <XCircle className="size-3.5 shrink-0 text-danger" aria-hidden />
              )}
            </button>
          )
        })}
      </div>
      {answered && (
        <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
          {check.explanation}
        </p>
      )}
    </div>
  )
}

export function ExplanationPanel({ stage, snapshot }: ExplanationPanelProps) {
  const [level, setLevel] = useState<LearningLevel>('beginner')
  const reducedMotion = useReducedMotion()
  const [docsOpen, setDocsOpen] = useState(false)

  if (stage === null || snapshot === null) {
    return (
      <aside aria-label="Explanation" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <BookOpen className="size-5 text-text-muted" aria-hidden />
        <p className="text-xs text-text-muted">
          Start playback or pick a completed stage to see what SQL does here.
        </p>
      </aside>
    )
  }

  const explanation = explainStage(stage, snapshot, level)
  const docs = docsForStage(stage)
  const checkKey = `${stage}-${level}`

  return (
    <aside aria-label="Explanation" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-3 py-3">
      {/* Learning level switch */}
      <div
        role="tablist"
        aria-label="Learning level"
        className="flex shrink-0 rounded-lg border border-border bg-surface-2 p-0.5"
      >
        {LEARNING_LEVELS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={level === entry.id}
            onClick={() => setLevel(entry.id)}
            className={`flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
              level === entry.id
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <motion.div
        key={checkKey}
        initial={reducedMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.2 }}
        className="space-y-3"
      >
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">{explanation.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            {explanation.concept}
          </p>
          <p className="mt-1.5 text-[11px] text-text-muted italic">{explanation.why}</p>
        </div>

        {/* What actually happened */}
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">
            What happened
          </div>
          <p className="mt-1 text-xs leading-relaxed text-text-primary">
            {explanation.observation}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
            {explanation.detail}
          </p>
          <div className="mt-2 flex gap-3 text-[11px] text-text-muted">
            <span>Rows in: {explanation.rowsBefore}</span>
            <span>Rows out: {explanation.rowsAfter}</span>
          </div>
        </div>

        <KnowledgeCheckSection key={checkKey} stage={stage} level={level} />

        {/* Documentation */}
        <div className="rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setDocsOpen((open) => !open)}
            aria-expanded={docsOpen}
            className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold tracking-wide text-text-muted uppercase hover:text-text-secondary"
          >
            <span className="inline-flex items-center gap-1.5">
              <BookOpen className="size-3.5" aria-hidden />
              Documentation
            </span>
            <ChevronDown
              className={`size-3.5 transition-transform ${docsOpen ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
          {docsOpen && (
            <ul className="space-y-0.5 px-2 pb-2">
              {docs.map((doc) => (
                <li key={doc.url}>
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                  >
                    <span>{doc.label}</span>
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </aside>
  )
}
