'use client'
import { useState, useEffect, Suspense } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
// FIX (Workspace lifecycle + Onboarding, round 4): these were defined
// locally and duplicated (not just similarly, but re-typed) in
// api/workspace/create and api/workspace/settings, which never validated
// against them — importing the one shared list means the dropdown and
// the server-side validation literally cannot drift apart again.
import { INDUSTRIES, CURRENCIES, TIMEZONES, SOW_LANGUAGES } from '@/lib/constants/workspace-options'

const STEPS = [
  { label: 'Your agency',   sub: 'Identity & locale' },
  { label: 'Branding',      sub: 'Logo & colour' },
  { label: 'Defaults',      sub: 'SOW preferences' },
  { label: 'Team',          sub: 'First invitation' },
  { label: 'Done',          sub: 'Start governing' },
]

// FIX (round 3, Workspace lifecycle Finding 1): useSearchParams() (added
// to read the ?new=1 flag below) requires a Suspense boundary around any
// component that calls it, or Next.js fails/warns at build time. Keep the
// actual page logic in an inner component and wrap it here.
export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="ob-root"><div className="ob-card" /></div>}>
      <OnboardingWizard />
    </Suspense>
  )
}

function OnboardingWizard() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = createClient()
  // FIX (round 3, Workspace lifecycle Finding 1 — severe): set by the
  // Sidebar's "Create new workspace" link. Without an explicit signal,
  // this page had no way to distinguish "land here because you need to
  // finish setup" from "land here because you deliberately want a NEW
  // workspace" — it always deferred to onboarding-status, which returns
  // 'complete' (redirect straight to /dashboard) the instant the user has
  // any already-onboarded workspace, i.e. for virtually every existing
  // user. That made "Create new workspace" a permanent dead end. explicitNew
  // skips both the localStorage restore and the onboarding-status check
  // below so an existing, fully-onboarded user can actually start one.
  const explicitNew = searchParams.get('new') === '1'

  const [step,        setStep]        = useState(0)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)

  // Step 0
  const [agencyName, setAgencyName] = useState('')
  const [industry,   setIndustry]   = useState('')
  const [currency,   setCurrency]   = useState('USD')
  const [timezone,   setTimezone]   = useState('America/New_York')

  // Step 1
  const [brandColour,  setBrandColour]  = useState('#1A5C3A')
  const [logoFile,     setLogoFile]     = useState<File | null>(null)
  const [logoPreview,  setLogoPreview]  = useState<string | null>(null)
  const [uploading,    setUploading]    = useState(false)

  // Step 2
  const [revisionRounds,   setRevisionRounds]   = useState('2')
  const [paymentStructure, setPaymentStructure] = useState('50_50')
  // FIX (doc-completeness audit, finding #1): this used to default to
  // 'United States' and get saved to a column SOW generation never read,
  // so agencies would see it "saved" during onboarding while every SOW
  // silently used an unrelated fallback. Starts blank now — governing
  // law is a real legal term of the contract, not something we should
  // guess on the agency's behalf — and SOW generation hard-blocks until
  // it's actually set (see app/api/sow/generate/route.ts).
  const [governingLaw,     setGoverningLaw]     = useState('')
  // FIX (fresh independent audit, section 4): sow_language is a real,
  // generation-affecting workspace setting — lib/ai/sow-content.ts uses it to pick
  // which language a SOW is drafted in — and Step 2 already covers every other
  // field that shapes a generated SOW (revision rounds, payment structure,
  // governing law). It had no field here at all, so a workspace serving
  // non-English clients silently drafted every SOW in English until someone
  // remembered to go find this in Settings afterward. Defaults to 'en', the same
  // default the workspaces column and lib/ai/sow-content.ts itself use.
  const [sowLanguage,      setSowLanguage]       = useState('en')

  // Step 3
  const [inviteEmail, setInviteEmail] = useState('')
  // Audit round 2: the invite step used to send no role at all, so every teammate
  // silently received the workspace DEFAULT role — which, as seeded, can see all
  // projects, financials and client data and is subject to mandatory MFA. The owner
  // now sees and chooses the role.
  const [inviteRoles,  setInviteRoles]  = useState<Array<{ id: string; name: string; is_default: boolean }>>([])
  const [inviteRoleId, setInviteRoleId] = useState('')

  const STORAGE_KEY_PREFIX = 'scopegov_onboarding_'
  const [restored, setRestored] = useState(false)
  // FIX (deep audit, Workspace lifecycle + Onboarding sections — headline
  // finding): see api/workspace/onboarding-status/route.ts for the full
  // story. 'waiting' means this user is an ordinary member (not the
  // creator) of a real workspace they were invited into that hasn't
  // finished onboarding yet — render a waiting screen instead of ever
  // reaching the steps below, which would otherwise spin up a second,
  // unrelated workspace for them.
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — critical):
  // 'switch_error' added. See resumeTarget below and the resume-handling
  // block in the mount effect for the full story: reaching the wizard's
  // steps with the wrong workspace silently active is worse than not
  // reaching them at all, so a failed switch is now its own dead-end gate
  // rather than something the wizard quietly powers through.
  const [gate, setGate] = useState<'loading' | 'create' | 'waiting' | 'switch_error'>('loading')
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): workspaceId
  // added so the 'waiting' screen can offer a self-service "Leave this
  // workspace" — see the button below and onboarding-status/route.ts's own
  // comment on why 'waiting' now returns it.
  const [waitingFor, setWaitingFor] = useState<{ workspaceId: string; agencyName: string; creatorName: string } | null>(null)
  const [leavingWait, setLeavingWait] = useState(false)
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — critical):
  // powers the 'switch_error' gate below. Set when onboarding-status
  // resolves 'resume' for a workspace that isn't already the user's active
  // one and the follow-up POST /api/workspace/switch doesn't confirm
  // success — see the mount effect for why this can no longer be treated
  // as best-effort.
  const [resumeTarget, setResumeTarget] = useState<{ workspaceId: string; agencyName: string } | null>(null)
  const [retryingSwitch, setRetryingSwitch] = useState(false)
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
  // gap): see submitIdentity's own comment on the explicitNew create
  // path — powers the "resume that workspace instead" link on step 0.
  const [trialConflict, setTrialConflict] = useState(false)

  // FEATURE (deep audit, Workspace lifecycle + Onboarding re-pass —
  // feature gap): see restore_workspace_atomic's own comment (migration
  // 065) — before this, deleting a workspace (including a single
  // misclick on "Discard this workspace" below) was permanently one-way
  // from the product's point of view. Offered right where a brand-new-
  // looking "create" gate is the ONE place someone who just deleted their
  // only workspace can land with zero active memberships at all — every
  // other screen in the app needs one.
  const [restorable, setRestorable] = useState<Array<{ id: string; agencyName: string; deletedAt: string }>>([])
  const [restoringId, setRestoringId] = useState<string | null>(null)

  // FIX (Workspace lifecycle + Onboarding, round 4 — headline feature
  // gap): middleware.ts only gates PAGE routes on onboarding completion,
  // not /api/* — so once a workspace is created (and becomes active),
  // every page except /onboarding is unreachable until this wizard is
  // finished, including Settings, where "Delete workspace" lives. There
  // was no sign-out, no "switch workspace," and no "discard this
  // workspace" control anywhere in steps 0–4 (only the 'waiting' screen
  // for invited members had an escape hatch at all). A creator who
  // regrets clicking "Create new workspace," or gets interrupted and
  // comes back not wanting to finish it, had no self-service way out —
  // finish the wizard for a workspace they don't want, or email support.
  // otherWorkspaces powers a small exit panel (see below) offering
  // "switch to an existing workspace" and "discard this one."
  const [otherWorkspaces, setOtherWorkspaces] = useState<Array<{ id: string; agencyName: string; name: string; onboardingComplete?: boolean }>>([])
  const [showExit, setShowExit] = useState(false)

  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — critical):
  // extracted so the resume path (mount effect) and its retry button (the
  // 'switch_error' gate below) share one implementation. Returns whether
  // the switch actually took — callers must not proceed to render or
  // submit wizard steps on a `false` result, since every downstream write
  // resolves its target off the server's active workspace, not any id
  // this component happens to be holding in state.
  async function switchIntoWorkspace(id: string): Promise<boolean> {
    try {
      const res = await fetch('/api/workspace/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: id }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/login'); return }

      // FIX (round 3, Workspace lifecycle Finding 1): explicit intent to
      // start a NEW workspace overrides both the localStorage restore and
      // the onboarding-status check below — otherwise either one could
      // silently resume/redirect away from the brand-new workspace this
      // click was for. Clear any stale saved progress first so a leftover
      // in-progress record for a DIFFERENT (already-abandoned) workspace
      // doesn't get resumed instead.
      if (explicitNew) {
        try { localStorage.removeItem(STORAGE_KEY_PREFIX + user.id) } catch { /* ignore */ }
        // FIX (fresh independent audit, section 4): explicitNew is reached both by a
        // genuine full page load (Sidebar's "Create new workspace" link — a different
        // route, so this component mounts fresh and every field below is already at
        // its useState default) AND by discardWorkspace()'s own `router.replace
        // ('/onboarding?new=1')` fallback — a query-string-only navigation on this
        // SAME route, which does NOT remount the component. In that second case this
        // branch used to only ever touch agencyName/restored/gate, so every other
        // field — industry, currency, timezone, brandColour, the picked logoFile/
        // logoPreview, revisionRounds, paymentStructure, governingLaw, inviteEmail,
        // inviteRoleId, inviteRoles, trialConflict — silently carried the DISCARDED
        // workspace's values into what the wizard presents as a blank new workspace.
        // Concretely: a still-held logoFile got re-uploaded to the new workspace
        // without the user ever touching the file picker again, and — worse —
        // inviteRoles/inviteRoleId held a role id scoped to the now-deleted
        // workspace, which the step-3 fetch effect never re-ran for (it's guarded on
        // `inviteRoles.length > 0`, already true from the old session), so a step-3
        // invite could be submitted with a roleId that doesn't exist in the new
        // workspace at all. "Start a new workspace" now actually starts blank,
        // whichever of the two paths got here.
        //
        // FIX (fresh independent audit, section 4 — this pass): the reset above still
        // didn't clear `workspaceId` itself. Every caller reaching this branch today
        // happens to already have it null — a fresh mount starts at useState(null), and
        // discardWorkspace() (below) explicitly calls setWorkspaceId(null) of its own
        // accord before its router.replace('/onboarding?new=1') — but this is still a
        // query-string-only navigation on the SAME route, which App Router does not
        // remount for. Reached any other way — a bookmarked or browser-history
        // '/onboarding?new=1' revisited while a different, still-in-progress
        // workspace's wizard is already live in this tab's state — workspaceId would
        // survive as that stale id. submitIdentity()'s existing-workspaceId branch
        // (a few hundred lines down) only PATCHes rather than creates when workspaceId
        // is already set, so "start a new workspace" would silently overwrite that old
        // workspace's settings instead of creating the new one the user asked for.
        // Reset it explicitly here so this branch is correct standalone, not just
        // correct because of what every current caller happens to do first.
        setWorkspaceId(null)
        const userName = user.user_metadata?.name || ''
        setAgencyName(userName ? `${userName.split(' ')[0]}'s Agency` : '')
        setIndustry('')
        setCurrency('USD')
        setTimezone('America/New_York')
        setBrandColour('#1A5C3A')
        setLogoFile(null)
        setLogoPreview(null)
        setRevisionRounds('2')
        setPaymentStructure('50_50')
        setGoverningLaw('')
        setSowLanguage('en')
        setInviteEmail('')
        setInviteRoleId('')
        setInviteRoles([])
        setTrialConflict(false)
        setError('')
        setShowExit(false)
        setStep(0)
        setRestored(true)
        setGate('create')
        return
      }

      // FIX (Workspace lifecycle + Onboarding, round 4 — headline): this
      // used to trust localStorage FIRST and return early on any saved
      // workspaceId, entirely skipping the onboarding-status check below —
      // the exact "which workspace is really active/incomplete" logic
      // onboarding-status/route.ts's Finding 6 was hardened for. If
      // active_workspace_id had changed since the last local save
      // (switched devices, a different workspace was created/abandoned in
      // the meantime, support intervened), the wizard silently resumed
      // progress for the WRONG, stale workspace while whatever's actually
      // active stayed incomplete forever — a redirect loop with no
      // explanation, using the identical failure mode Finding 6 exists to
      // prevent, just via this early-return path instead. Always ask the
      // server first now; localStorage only ever supplements the server's
      // answer (for the SAME workspace), never overrides it.
      let status: any = null
      let statusFetchFailed = false
      try {
        const res  = await fetch('/api/workspace/onboarding-status')
        const json = await res.json().catch(() => ({}))
        if (res.ok) status = json
        else statusFetchFailed = true
      } catch { statusFetchFailed = true }

      if (status?.status === 'complete') {
        try { localStorage.removeItem(STORAGE_KEY_PREFIX + user.id) } catch { /* ignore */ }
        router.push('/dashboard')
        return
      }

      if (status?.status === 'waiting') {
        try { localStorage.removeItem(STORAGE_KEY_PREFIX + user.id) } catch { /* ignore */ }
        setWaitingFor({ workspaceId: status.workspaceId, agencyName: status.agencyName, creatorName: status.creatorName })
        setGate('waiting')
        setRestored(true)
        return
      }

      if (status?.status === 'resume' && status.workspaceId) {
        // FIX (Workspace lifecycle, round 4): onboarding-status can
        // legitimately resolve to an owned incomplete workspace that ISN'T
        // the user's currently active one (e.g. an older abandoned
        // workspace, picked because the real active workspace is already
        // fully onboarded or there is no active pick at all). Nothing
        // used to make the resumed workspace active — complete() would
        // finish onboarding for it and redirect to /dashboard, landing
        // the user in whatever workspace WAS active instead of the one
        // they just set up. Explicitly switch into it first.
        //
        // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
        // CRITICAL, headline finding): this used to be best-effort — the
        // response wasn't even checked (fetch only throws on a
        // network-level failure, never on a resolved non-2xx), on the
        // theory that "onboarding still completes correctly for this
        // workspace." That's false for every OTHER write the wizard makes
        // between here and complete-onboarding: PATCH workspace/settings,
        // PATCH workspace/branding, POST workspace/branding/logo, and
        // POST/PATCH workspace/defaults all resolve their target off
        // session.workspaceId (the server's active workspace) — by
        // design, the same confused-deputy defense workspace/switch and
        // team/invite's own comments describe — NOT off this component's
        // workspaceId state. If the switch above silently failed while
        // this resumed workspace differs from whatever WAS already
        // active, every step-0-through-3 save from here on would land on
        // that other, unrelated, already-live workspace instead —
        // silently overwriting its real name/industry/branding/SOW
        // defaults and even sending a real team invite into it — while
        // complete-onboarding (which DOES take workspaceId from the body)
        // would still mark the RESUMED workspace done, despite it never
        // having received any of that data. A failed switch must block
        // entering the wizard, not just be logged and ignored.
        const switchOk = await switchIntoWorkspace(status.workspaceId)
        if (!switchOk) {
          setResumeTarget({ workspaceId: status.workspaceId, agencyName: status.agencyName || '' })
          setGate('switch_error')
          setRestored(true)
          return
        }

        setWorkspaceId(status.workspaceId)
        if (status.agencyName) setAgencyName(status.agencyName)
        if (status.industry)   setIndustry(status.industry)
        if (status.currency)   setCurrency(status.currency)
        if (status.timezone)   setTimezone(status.timezone)
        if (status.brandColour)      setBrandColour(status.brandColour)
        if (status.logoStoragePath)  setLogoPreview(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/logos/${status.logoStoragePath}`)
        if (status.revisionRounds)   setRevisionRounds(status.revisionRounds)
        if (status.paymentStructure) setPaymentStructure(status.paymentStructure)
        if (status.governingLaw)     setGoverningLaw(status.governingLaw)
        if (status.sowLanguage)      setSowLanguage(status.sowLanguage)

        // Local progress only ever supplements the server's pick — and
        // only the in-progress `step` position, since every field above
        // now comes from the server. Only trust it when it's for the
        // SAME workspace the server just resolved; otherwise it's a
        // stale record for a workspace that's no longer the relevant
        // one, and clinging to it is exactly the bug this fix closes.
        let resumeStep = 1
        try {
          const saved = localStorage.getItem(STORAGE_KEY_PREFIX + user.id)
          if (saved) {
            const s = JSON.parse(saved)
            if (s.workspaceId === status.workspaceId && s.step) {
              resumeStep = s.step
            } else {
              localStorage.removeItem(STORAGE_KEY_PREFIX + user.id)
            }
          }
        } catch { /* corrupt storage — ignore, server-derived state stands */ }

        setStep(resumeStep)
        setRestored(true)
        setGate('create')
        return
      }

      // status is 'create', or the status check itself failed — degrade
      // to trusting local progress ONLY on an actual fetch failure (e.g.
      // offline), since that's the one case there's no server answer to
      // validate against at all. Every write from here on (settings,
      // branding, defaults, complete-onboarding) still independently
      // verifies the workspace belongs to this user, so a stale/wrong
      // resume here can't corrupt another workspace's data — it can only
      // mis-resume, same residual risk any offline-first restore has.
      if (statusFetchFailed) {
        try {
          const saved = localStorage.getItem(STORAGE_KEY_PREFIX + user.id)
          if (saved) {
            const s = JSON.parse(saved)
            if (s.workspaceId) {
              setWorkspaceId(s.workspaceId)
              setStep(s.step || 1)
              if (s.agencyName)       setAgencyName(s.agencyName)
              if (s.industry)         setIndustry(s.industry)
              if (s.currency)         setCurrency(s.currency)
              if (s.timezone)         setTimezone(s.timezone)
              if (s.brandColour)      setBrandColour(s.brandColour)
              if (s.revisionRounds)   setRevisionRounds(s.revisionRounds)
              if (s.paymentStructure) setPaymentStructure(s.paymentStructure)
              if (s.governingLaw)     setGoverningLaw(s.governingLaw)
              if (s.sowLanguage)      setSowLanguage(s.sowLanguage)
              setRestored(true)
              setGate('create')
              return
            }
          }
        } catch { /* corrupt/unavailable storage too — just start fresh below */ }
      }

      try { localStorage.removeItem(STORAGE_KEY_PREFIX + user.id) } catch { /* ignore */ }
      const userName = user.user_metadata?.name || ''
      if (userName) setAgencyName(`${userName.split(' ')[0]}'s Agency`)
      setRestored(true)
      setGate('create')
    })
  }, [explicitNew])

  // Persist on every relevant change, once initial restore has happened
  // (avoids overwriting saved progress with blank initial state before
  // restore runs).
  useEffect(() => {
    if (!restored || !workspaceId) return
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      localStorage.setItem(STORAGE_KEY_PREFIX + user.id, JSON.stringify({
        step, workspaceId, agencyName, industry, currency, timezone,
        brandColour, revisionRounds, paymentStructure, governingLaw, sowLanguage,
      }))
    })
  }, [restored, step, workspaceId, agencyName, industry, currency, timezone, brandColour, revisionRounds, paymentStructure, governingLaw, sowLanguage])

  function clearSavedProgress() {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) localStorage.removeItem(STORAGE_KEY_PREFIX + user.id)
    })
  }

  // Powers the exit panel below — only meaningful once a workspace
  // actually exists (steps 1-4, or a resumed step 0) and the user is a
  // creator working through the wizard (the 'waiting' gate never sets
  // workspaceId, so this never runs for invited members).
  useEffect(() => {
    if (gate !== 'create' || !workspaceId) return
    fetch('/api/workspace/list')
      .then(r => r.json())
      .then(json => {
        if (Array.isArray(json.workspaces)) {
          // FIX (deep audit, Workspace lifecycle + Onboarding re-pass):
          // this used to offer every other workspace the user belongs to,
          // regardless of whether IT had finished onboarding — the panel's
          // own copy ("a workspace you already set up") promised a
          // working destination, but a still-incomplete one just bounces
          // the user right back into /onboarding for THAT workspace with
          // no explanation. Only offer ones that are actually done.
          setOtherWorkspaces(json.workspaces.filter((w: any) => w.id !== workspaceId && w.onboardingComplete))
        }
      })
      .catch(() => { /* non-critical — exit panel just won't offer a switch target */ })
  }, [gate, workspaceId])

  // FEATURE (deep audit, Workspace lifecycle + Onboarding re-pass —
  // feature gap): only relevant before this session has created or
  // resumed anything of its own (workspaceId still null) — once a
  // workspace exists to work on, the exit panel above already covers
  // "not this one" for anything ELSE the user owns.
  useEffect(() => {
    if (gate !== 'create' || workspaceId) return
    fetch('/api/workspace/restore')
      .then(r => r.json())
      .then(json => { if (Array.isArray(json.restorable)) setRestorable(json.restorable) })
      .catch(() => { /* non-critical — restore offer just won't show */ })
  }, [gate, workspaceId])

  async function restoreWorkspace(id: string) {
    setRestoringId(id); setError('')
    try {
      const res  = await fetch('/api/workspace/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || 'Could not restore that workspace. Try again.')
        return
      }
      clearSavedProgress()
      router.push('/dashboard')
    } catch {
      setError('Could not restore that workspace. Try again.')
    } finally { setRestoringId(null) }
  }

  async function switchToWorkspace(id: string) {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/workspace/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error || 'Could not switch workspaces — try again.'); return }
      clearSavedProgress()
      router.push('/dashboard')
    } catch { setError('Could not switch workspaces — try again.') }
    finally { setLoading(false) }
  }

  async function discardWorkspace() {
    if (!workspaceId) return
    if (typeof window !== 'undefined' && !window.confirm(
      'Discard this workspace? Everything entered so far will be permanently deleted. This can\u2019t be undone.'
    )) return
    setLoading(true); setError('')
    try {
      // FIX (fresh independent audit, Workspace lifecycle + Onboarding):
      // workspace/delete requires the caller to type the workspace's
      // exact `name` (what session.workspaceName reads) as `confirmName`
      // in the request body — this call sent NO body at all, so every
      // discard here unconditionally hit "Type the workspace name to
      // confirm deletion" and 400'd. This screen deliberately uses a
      // plain window.confirm() rather than a typed-name box (unlike
      // Settings > Danger Zone — nothing real has been invested yet at
      // this point in the wizard), so fetch the authoritative `name`
      // server-side rather than trust local `agencyName` state, which can
      // have drifted from it: going back to step 0 and editing only PATCHes
      // `agency_name` via workspace/settings, never the separate `name`
      // column workspace/delete actually checks against.
      const listRes  = await fetch('/api/workspace/list')
      const listJson = await listRes.json().catch(() => ({}))
      const current  = Array.isArray(listJson.workspaces)
        ? listJson.workspaces.find((w: any) => w.id === workspaceId)
        : null
      if (!listRes.ok || !current?.name) {
        setError('Could not discard this workspace — try again, or contact support@scopegov.app.')
        return
      }
      const res  = await fetch('/api/workspace/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: current.name }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || 'Could not discard this workspace — try again, or contact support@scopegov.app.')
        return
      }
      clearSavedProgress()
      if (otherWorkspaces.length > 0) {
        await switchToWorkspace(otherWorkspaces[0].id)
        return
      }
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
      // feature gap): this used to go straight to '/onboarding?new=1' —
      // the exact flag the mount effect's own comment says deliberately
      // SKIPS resume-detection — the moment otherWorkspaces (deliberately
      // scoped to already-*completed* workspaces only) came up empty.
      // Migration 019's trial_cap_exempt grandfather clause proves a user
      // can legitimately own two INCOMPLETE workspaces at once; discarding
      // one used to silently strand the other rather than ever offering
      // to resume it — the user got shoved into starting a brand-new
      // third workspace instead. Ask the server directly before assuming
      // there's nothing left to resume.
      //
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — round
      // 2, flagship): this only ever matched status === 'resume', but
      // onboarding-status can just as legitimately come back 'waiting' —
      // pickFallbackMembership (see workspace/delete's own comment) prefers
      // a completed workspace when one exists, but falls back to the
      // OLDEST membership otherwise, completed or not. A user who discards
      // their in-progress workspace and lands, via that fallback, on an
      // older membership where someone ELSE is still the creator gets
      // exactly that: 'waiting', not 'resume'. Falling through to
      // '/onboarding?new=1' here — the one flag that explicitly SKIPS this
      // very status check — silently hid that pending membership and let
      // the user spin up a third workspace instead of seeing the waiting
      // screen. 'complete' is included too for the same reason: nothing
      // structurally rules it out here, and it costs nothing to let the
      // mount effect's own already-hardened per-status handling decide,
      // rather than re-deciding a subset of it here a second time.
      setOtherWorkspaces([])
      try {
        const res  = await fetch('/api/workspace/onboarding-status')
        const json = await res.json().catch(() => ({}))
        if (res.ok && json.workspaceId &&
            (json.status === 'resume' || json.status === 'waiting' || json.status === 'complete')) {
          // Best-effort switch, then a full reload so the mount effect's
          // own (already-hardened) per-status logic re-runs from scratch
          // and populates every field from the server — rather than
          // duplicating that logic a second time here.
          try {
            await fetch('/api/workspace/switch', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspaceId: json.workspaceId }),
            })
          } catch { /* best-effort */ }
          window.location.assign('/onboarding')
          return
        }
      } catch { /* status check failed — fall through to starting fresh */ }
      setWorkspaceId(null)
      setStep(0)
      router.replace('/onboarding?new=1')
    } catch {
      setError('Could not discard this workspace — try again, or contact support@scopegov.app.')
    } finally { setLoading(false) }
  }

  /* ── Step 0: Identity ─────────────────────────────────────── */
  async function submitIdentity(e: React.FormEvent) {
    e.preventDefault()
    if (!agencyName.trim() || !industry) return
    // FIX: if the user went Back to step 0 after already creating the
    // workspace (or somehow double-submitted), don't create a second one.
    // Persist any edits via the settings route instead, then advance.
    if (workspaceId) {
      setLoading(true); setError('')
      try {
        // FIX (section-by-section re-audit): this used to be a
        // fire-and-forget .catch(() => {}) that swallowed any server-side
        // rejection and silently advanced regardless — same shape the
        // invite step (below) was already fixed for. A failed save here
        // now blocks advancing and shows why, instead of the user
        // believing their agency identity edits were saved when they
        // weren't.
        const res  = await fetch('/api/workspace/settings', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, agencyName, industry, currency, timezone }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(json.error || 'Could not save those changes — try again.')
          return
        }
        setStep(1)
      } catch {
        setError('Could not save those changes — try again.')
      } finally { setLoading(false) }
      return
    }
    setLoading(true); setError(''); setTrialConflict(false)
    try {
      const res  = await fetch('/api/workspace/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyName, industry, currency, timezone }),
      })
      const json = await res.json()
      if (!res.ok) {
        // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
        // feature gap): explicitNew deliberately skips resume-detection
        // (see its own comment above), so hitting
        // one_active_trial_per_creator (migration 019) here — a real,
        // reachable case: an earlier abandoned trial workspace still
        // counts as "active" until deleted — left the person with only
        // this error, naming "delete it" as an option with no way to
        // actually reach it from this screen. Detect that specific 409
        // and offer the one real way back to it.
        if (res.status === 409 && /active trial workspace/i.test(String(json.error || ''))) {
          setTrialConflict(true)
        }
        throw new Error(json.error || 'Failed to create workspace')
      }
      setWorkspaceId(json.workspaceId)
      setStep(1)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setLoading(false) }
  }

  /* ── Step 1: Branding ─────────────────────────────────────── */
  // FIX (section-by-section re-audit — headline finding): this used to
  // upload directly from the browser via the anon-key client to
  // `${workspaceId}/logo.${ext}`. The `logos` bucket's storage policy is
  // scoped `<auth.uid()>/<filename>` (see api/workspace/branding/route.ts),
  // keyed on the USER, not the workspace — a brand-new workspace's UUID
  // is never equal to the current user's id, so that upload was rejected
  // by storage RLS on every single run, for every user, silently (the
  // failure was swallowed and the FileReader preview kept showing the
  // picked image regardless, so nobody could tell). It was ALSO,
  // independently, the exact insecure pattern
  // api/workspace/branding/logo/route.ts exists specifically to replace:
  // a client-side-only write with no magic-byte check, and — the serious
  // part — this file's own accepted-types list still allowed
  // image/svg+xml, the same live stored-XSS vector (a `<script>` inside
  // an SVG served from the public bucket's own origin) the team already
  // found and fixed by dropping SVG support entirely for the equivalent
  // Settings-page flow. It was inert today only by accident of the path
  // mismatch above. Fixed by routing through the same hardened
  // server-side endpoint Settings already uses (FormData POST, PNG/JPG
  // only, magic-byte verified, service-role write) instead of
  // reimplementing upload logic here.
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): the
  // validation below only ever accepted PNG/JPEG (the comment above this
  // function already explains why — dropping SVG closed a stored-XSS
  // vector), but the file input's own `accept` attribute and the caption
  // right next to it, a few lines down, still said "PNG, JPEG, or SVG" —
  // leftover copy from before that fix that let the browser's file picker
  // show SVGs and told the user they were supported, only for this
  // handler to immediately reject the exact file type it had just
  // advertised. Also added the file-size check the caption's "Max 2 MB"
  // claim never actually enforced — a large file previously sailed
  // through here and only failed after a full upload attempt, server-side
  // in workspace/branding/logo/route.ts.
  const MAX_LOGO_BYTES = 2 * 1024 * 1024
  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!['image/png','image/jpeg'].includes(file.type)) {
      setError('Logo must be PNG or JPG.'); return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError('Logo must be 2MB or smaller.'); return
    }
    setError('')
    setLogoFile(file)
    const reader = new FileReader()
    reader.onload = ev => setLogoPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  async function submitBranding() {
    if (!workspaceId) return
    setLoading(true)
    setError('')
    try {
      let logoStoragePath: string | undefined
      if (logoFile) {
        setUploading(true)
        const body = new FormData()
        body.append('file', logoFile)
        const upRes  = await fetch('/api/workspace/branding/logo', { method: 'POST', body })
        const upJson = await upRes.json().catch(() => ({}))
        setUploading(false)
        if (!upRes.ok) {
          setError(upJson.error || 'Could not upload logo — you can add it later in Settings.')
          return
        }
        logoStoragePath = upJson.logoStoragePath
      }
      const res  = await fetch('/api/workspace/branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, brandColour, ...(logoStoragePath ? { logoStoragePath } : {}) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || 'Branding save failed — you can update this in Settings.')
        return
      }
      setStep(2)
    } catch { setError('Branding save failed — you can update this in Settings.') }
    finally { setLoading(false); setUploading(false) }
  }

  /* ── Step 2: Defaults ─────────────────────────────────────── */
  async function submitDefaults() {
    if (workspaceId) {
      setLoading(true); setError('')
      // FIX (section-by-section re-audit): this used to be a
      // fire-and-forget .catch(() => {}) marked "non-fatal" that silently
      // advanced regardless of the response. governingLaw is the exact
      // field api/sow/generate/route.ts hard-blocks SOW generation
      // without — a silently-failed save here meant the user believed
      // governing law was set (they typed it, clicked Continue, saw no
      // error) and only discovered otherwise when SOW generation blocked
      // them, with nothing connecting that back to this step.
      try {
        const res  = await fetch('/api/workspace/defaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, revisionRounds: parseInt(revisionRounds), paymentStructure, governingLaw, sowLanguage }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(json.error || 'Could not save your defaults — try again, or skip this step.')
          return
        }
      } catch {
        setError('Could not save your defaults — try again, or skip this step.')
        return
      } finally { setLoading(false) }
    }
    setStep(3)
  }

  useEffect(() => {
    if (step !== 3 || !workspaceId || inviteRoles.length > 0) return
    fetch('/api/team/roles')
      .then(r => r.json())
      .then(json => {
        if (!Array.isArray(json.roles)) return
        setInviteRoles(json.roles)
        const def = json.roles.find((r: any) => r.is_default)
        if (def) setInviteRoleId(def.id)
      })
      .catch(() => { /* non-critical — the invite just falls back to the workspace default role */ })
  }, [step, workspaceId, inviteRoles.length])

  /* ── Step 3: Invite ───────────────────────────────────────── */
  async function submitInvite() {
    setError('')
    if (inviteEmail.trim() && workspaceId) {
      setLoading(true)
      try {
        const res  = await fetch('/api/team/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: inviteEmail, workspaceId, ...(inviteRoleId ? { roleId: inviteRoleId } : {}) }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          // FIX: this used to be a fire-and-forget .catch(() => {}) that
          // swallowed any error (invalid email, etc.) and silently advanced
          // to the next step regardless — the person had no idea nothing
          // was sent. Now a failed invite blocks advancing and shows why.
          setError(json.error || 'Could not send that invite — check the email address, or skip this step.')
          return
        }
      } catch {
        // FIX (fresh independent audit, Workspace lifecycle + Onboarding):
        // every sibling step function in this wizard (submitIdentity,
        // submitBranding, submitDefaults, complete, restoreWorkspace,
        // switchToWorkspace, discardWorkspace, leaveWaitingWorkspace)
        // catches a network-level fetch failure and shows a generic error
        // — this was the one step that didn't. A network-level throw (offline,
        // DNS blip — fetch only throws on those, never on a resolved
        // non-2xx) propagated unhandled: loading still cleared via
        // `finally` below, but no error was ever shown and the wizard
        // never advanced, silently stranding the user on step 3 with no
        // explanation.
        setError('Could not send that invite — check your connection and try again, or skip this step.')
        return
      } finally { setLoading(false) }
    }
    setStep(4)
  }

  /* ── Step 4: Complete ─────────────────────────────────────── */
  // FIX (round 3, Onboarding Finding 1 — severe): this used to ignore the
  // fetch response entirely — no res.ok check at all. That completely
  // defeated complete-onboarding/route.ts's own Finding 4 fix (which made
  // the backend correctly return a 404 on a workspaceId mismatch): no
  // matter what the backend returned, this cleared all local progress and
  // navigated to /dashboard. Middleware then immediately bounced back to
  // /onboarding (onboarding_completed_at was never actually set) — but by
  // then the saved progress was already gone, so the user landed back at
  // step 0 of a blank wizard with everything they'd entered erased, in a
  // loop that erased their work every time they clicked "Go to dashboard."
  // Now returns whether it actually succeeded, and callers act on that.
  // FIX (fresh independent audit, section 4 — minor): this used to always navigate to
  // '/dashboard' itself on success. "Create first project" below then awaited complete()
  // and, on true, pushed to '/projects/new' as a SECOND router.push right after — two
  // navigations queued in the same tick, the dashboard one immediately superseded by the
  // real destination. Harmless to final state (last push wins) but a wasted transition
  // that can flash the dashboard before landing on the project form. Takes the intended
  // destination as a parameter so there's only ever one push.
  async function complete(redirectTo: string = '/dashboard'): Promise<boolean> {
    if (!workspaceId) return false
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/workspace/complete-onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || 'Could not finish setting up your workspace — try again.')
        return false
      }
      clearSavedProgress()
      router.push(redirectTo)
      return true
    } catch {
      setError('Could not finish setting up your workspace — try again.')
      return false
    } finally { setLoading(false) }
  }

  // FIX (round 3, Onboarding Finding 3 — minor): the 'waiting' screen's
  // own copy promises "you'll get full access automatically — no need to
  // do anything here," but nothing here ever re-checked status — an
  // invited member watching this screen while the creator finishes setup
  // would just sit there indefinitely unless they manually reloaded.
  // Poll and move on once the creator completes onboarding.
  //
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this only
  // ever handled status === 'complete'. If the creator discards/deletes
  // the workspace while a member is sitting on this screen (the 'create'
  // gate's own exit panel explicitly offers "Discard this workspace"),
  // that member's only active membership disappears and onboarding-status
  // flips to 'create' — but nothing here checked for that, so they stayed
  // stuck on "Almost there" indefinitely, for a workspace that no longer
  // exists, with the screen giving no indication anything had changed.
  // Any transition away from 'waiting' means what's on screen is stale;
  // reload rather than duplicate this page's own create/resume/waiting/
  // complete routing here a second time.
  useEffect(() => {
    if (gate !== 'waiting') return
    const interval = setInterval(async () => {
      try {
        const res  = await fetch('/api/workspace/onboarding-status')
        const json = await res.json().catch(() => ({}))
        if (!res.ok) return
        if (json.status === 'complete') { router.push('/dashboard'); return }
        if (json.status && json.status !== 'waiting') window.location.reload()
      } catch { /* transient — try again next tick */ }
    }, 15000)
    return () => clearInterval(interval)
  }, [gate])

  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
  // gap): the 'create' gate got a whole exit panel ("switch to a
  // workspace you already set up" / "discard this one") built specifically
  // because there was no self-service way out of an in-progress workspace.
  // The symmetric problem on the invited-member side — stuck waiting on a
  // slow or absent creator, with no other workspace to fall back to — was
  // never solved: Team's per-workspace "Leave" and the Sidebar switcher's
  // "Leave" both live inside the (app) layout, which itself redirects back
  // to /onboarding while incomplete, so they're structurally unreachable
  // from this screen. This lets a waiting member leave THIS specific
  // pending membership directly, the same self-service the 'create' side
  // already has.
  async function leaveWaitingWorkspace() {
    if (!waitingFor?.workspaceId) return
    if (typeof window !== 'undefined' && !window.confirm(
      `Leave "${waitingFor.agencyName}"? You'll need a new invite to rejoin.`
    )) return
    setLeavingWait(true); setError('')
    try {
      const res  = await fetch('/api/workspace/leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: waitingFor.workspaceId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || 'Could not leave that workspace. Try again.')
        return
      }
      // Whatever comes next (another workspace to fall back into, or
      // none at all) is exactly what this page's own mount-time logic
      // already knows how to route — reload rather than re-derive it here.
      window.location.reload()
    } catch {
      setError('Could not leave that workspace. Try again.')
    } finally { setLeavingWait(false) }
  }

  // FIX (deep audit, Workspace lifecycle + Onboarding sections): brief
  // blank beat while onboarding-status resolves, rather than flashing
  // Step 1 of the wizard (and its "Continue" button) for a split second
  // before possibly redirecting into 'waiting' or 'complete'.
  if (gate === 'loading') {
    return <div className="ob-root"><div className="ob-card" /></div>
  }

  if (gate === 'waiting') {
    return (
      <div className="ob-root">
        <div className="ob-card" style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ width: 64, height: 64, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="ti ti-hourglass" style={{ fontSize: 28, color: 'var(--text-3)' }} />
          </div>
          <h2 className="ob-title" style={{ textAlign: 'center' }}>Almost there</h2>
          <p className="ob-sub" style={{ textAlign: 'center', marginBottom: 28 }}>
            You&rsquo;ve joined <strong style={{ color: 'var(--text)' }}>{waitingFor?.agencyName}</strong> on ScopeGov,
            but {waitingFor?.creatorName} hasn&rsquo;t finished setting up the workspace yet. Once they do,
            you&rsquo;ll get full access automatically — no need to do anything here.
          </p>
          {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 280, margin: '0 auto' }}>
            {/* FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
                feature gap): see leaveWaitingWorkspace()'s own comment —
                previously "Sign out" was the only option on this screen. */}
            {waitingFor?.workspaceId && (
              <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}
                disabled={leavingWait} onClick={leaveWaitingWorkspace}>
                {leavingWait ? <span className="spin spin-dark" /> : 'Leave this workspace'}
              </button>
            )}
            {/* FIX (deep audit, Auth+MFA section): default signOut() scope
                is 'global' (every session everywhere), not just this one —
                see Sidebar.tsx's signOut for the full writeup. An ordinary
                "sign out" click here has no reason to be that aggressive. */}
            <button className="ob-skip" style={{ width: '100%', justifyContent: 'center', display: 'flex' }}
              disabled={leavingWait}
              onClick={() => supabase.auth.signOut({ scope: 'local' }).then(() => router.push('/login'))}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
  }

  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — critical):
  // reached only when onboarding-status resolved 'resume' for a workspace
  // that wasn't already active AND the follow-up switch didn't confirm
  // success — see switchIntoWorkspace's call site above for the full
  // story. Deliberately a dead end rather than falling through to the
  // wizard: every save from step 0 onward trusts the server's active
  // workspace, not resumeTarget.workspaceId, so rendering the form here
  // would silently start editing whatever workspace WAS already active.
  if (gate === 'switch_error') {
    return (
      <div className="ob-root">
        <div className="ob-card" style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ width: 64, height: 64, background: 'var(--red-lt, #fdecea)', border: '1px solid var(--red-mid, #f5c6c2)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="ti ti-alert-triangle" style={{ fontSize: 28, color: 'var(--red, #c0392b)' }} />
          </div>
          <h2 className="ob-title" style={{ textAlign: 'center' }}>Couldn&rsquo;t resume that workspace</h2>
          <p className="ob-sub" style={{ textAlign: 'center', marginBottom: 28 }}>
            We found {resumeTarget?.agencyName ? <>your in-progress workspace <strong style={{ color: 'var(--text)' }}>{resumeTarget.agencyName}</strong></> : 'an in-progress workspace'},
            but couldn&rsquo;t switch into it just now — try again rather than continuing, so nothing you enter next
            accidentally gets saved to a different workspace.
          </p>
          {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 280, margin: '0 auto' }}>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '11px' }}
              disabled={retryingSwitch}
              onClick={async () => {
                if (!resumeTarget?.workspaceId) return
                setRetryingSwitch(true); setError('')
                const ok = await switchIntoWorkspace(resumeTarget.workspaceId)
                setRetryingSwitch(false)
                if (ok) {
                  // Full reload rather than re-deriving resume state here a
                  // second time — the mount effect already knows how to
                  // populate every field from the server once the switch
                  // has actually taken.
                  window.location.assign('/onboarding')
                } else {
                  setError('Still couldn\u2019t switch workspaces. Check your connection and try again.')
                }
              }}>
              {retryingSwitch ? <span className="spin" /> : 'Try again'}
            </button>
            <button className="ob-skip" style={{ width: '100%', justifyContent: 'center', display: 'flex' }}
              disabled={retryingSwitch}
              onClick={() => supabase.auth.signOut({ scope: 'local' }).then(() => router.push('/login'))}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ob-root">
      <div className="ob-card">
        {/* Progress bar */}
        <div className="ob-progress">
          {STEPS.map((_, i) => (
            <div key={i} className={`ob-prog-seg ${i <= step ? 'done' : 'pending'}`} />
          ))}
        </div>

        {/* Step label */}
        <div className="ob-step-lbl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>Step {step + 1} of {STEPS.length} — {STEPS[step].label}</span>
          {/* FIX (Workspace lifecycle + Onboarding, round 4 — headline
              feature gap): the only self-service way out of an in-progress
              or abandoned workspace used to be finishing the wizard —
              Settings (where "Delete workspace" lives) is unreachable
              until onboarding_completed_at is set, and nothing here ever
              offered switching to a workspace the user already has. */}
          {workspaceId && (
            <button type="button" className="ob-skip" style={{ fontSize: 11, whiteSpace: 'nowrap' }}
              onClick={() => setShowExit(v => !v)}>
              Not this workspace?
            </button>
          )}
        </div>

        {workspaceId && showExit && (
          <div style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)' }}>
            {otherWorkspaces.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <p style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>Switch to a workspace you already set up:</p>
                {otherWorkspaces.map(w => (
                  <button key={w.id} type="button" className="btn btn-ghost btn-sm"
                    style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}
                    disabled={loading} onClick={() => switchToWorkspace(w.id)}>
                    {w.agencyName || w.name}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="btn btn-ghost btn-sm" style={{ display: 'block', width: '100%', textAlign: 'left' }}
              disabled={loading} onClick={discardWorkspace}>
              Discard this workspace
            </button>
            {/* FIX (deep audit, Auth+MFA section): same global-scope-by-
                default issue as the "Sign out" button above — see
                Sidebar.tsx's signOut for the full writeup. */}
            <button type="button" className="ob-skip" style={{ display: 'block', marginTop: 8, fontSize: 11 }}
              disabled={loading} onClick={() => supabase.auth.signOut({ scope: 'local' }).then(() => router.push('/login'))}>
              Sign out instead
            </button>
          </div>
        )}

        {/* ── STEP 0 ──────────────────────────────────────── */}
        {step === 0 && (
          <form onSubmit={submitIdentity}>
            <h2 className="ob-title">Tell us about your agency</h2>
            <p className="ob-sub">This appears on all client-facing documents and emails.</p>
            {error && <div className="auth-error">{error}</div>}
            {trialConflict && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginBottom: 16 }}
                onClick={() => window.location.assign('/onboarding')}>
                Go to that workspace instead
              </button>
            )}

            {/* FEATURE (deep audit, Workspace lifecycle + Onboarding
                re-pass — feature gap): see restore_workspace_atomic's own
                comment — a recently-deleted workspace of yours can be
                brought back within 30 days instead of starting fresh. */}
            {restorable.length > 0 && (
              <div style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)' }}>
                <p style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>Recently deleted — restore instead of starting over?</p>
                {restorable.map(w => (
                  <button key={w.id} type="button" className="btn btn-ghost btn-sm"
                    style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}
                    disabled={restoringId === w.id} onClick={() => restoreWorkspace(w.id)}>
                    {restoringId === w.id ? <span className="spin spin-dark" /> : `Restore "${w.agencyName}"`}
                  </button>
                ))}
              </div>
            )}

            <div className="fgrp">
              <label className="flbl">Agency name</label>
              <input className="finp" value={agencyName} placeholder="Meridian Creative" autoFocus required
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgencyName(e.target.value)} />
            </div>
            <div className="fgrp">
              <label className="flbl">Industry</label>
              <select className="finp" value={industry} required
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setIndustry(e.target.value)}>
                <option value="" disabled>Select your industry</option>
                {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div className="f2">
              <div className="fgrp">
                <label className="flbl">Default currency</label>
                <select className="finp" value={currency}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="fgrp">
                <label className="flbl">Timezone</label>
                <select className="finp" value={timezone}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTimezone(e.target.value)}>
                  {TIMEZONES.map(t => <option key={t} value={t}>{t.replace(/_/g,' ')}</option>)}
                </select>
              </div>
            </div>

            <div className="ob-nav">
              <span />
              <button type="submit" className="btn btn-primary" disabled={loading || !agencyName.trim() || !industry}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </form>
        )}

        {/* ── STEP 1 ──────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <h2 className="ob-title">Add your branding</h2>
            <p className="ob-sub">Your logo and brand colour appear on all SOW PDFs and client emails.</p>
            {error && <div className="auth-error">{error}</div>}

            <div className="fgrp">
              <label className="flbl">Agency logo</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 64, height: 64, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                  {logoPreview
                    ? <img src={logoPreview} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    : <i className="ti ti-building" style={{ fontSize: 24, color: 'var(--text-4)' }} />}
                </div>
                <div>
                  <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                    <i className="ti ti-upload" style={{ fontSize: 12 }} />
                    {uploading ? 'Uploading…' : logoFile ? 'Change logo' : 'Upload logo'}
                    <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }}
                      onChange={handleLogoChange} />
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>PNG or JPEG · Max 2 MB</p>
                </div>
              </div>
            </div>

            <div className="fgrp">
              <label className="flbl">Brand colour</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="color" value={brandColour}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBrandColour(e.target.value)}
                  style={{ width: 40, height: 38, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: 2, background: 'var(--surface)' }} />
                <input className="finp" value={brandColour} style={{ width: 130 }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBrandColour(e.target.value)}
                  placeholder="#1A5C3A" />
                <div style={{ width: 38, height: 38, borderRadius: 'var(--radius-sm)', background: brandColour, border: '1px solid var(--border)', flexShrink: 0 }} />
              </div>
            </div>

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(0)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button className="ob-skip" onClick={() => setStep(2)}>Skip for now</button>
              <button className="btn btn-primary" onClick={submitBranding} disabled={loading}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2 ──────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <h2 className="ob-title">Set your SOW defaults</h2>
            <p className="ob-sub">These pre-fill every new Statement of Work. You can override them per project at any time.</p>
            {error && <div className="auth-error">{error}</div>}

            <div className="f2">
              <div className="fgrp">
                <label className="flbl">Revision rounds (default)</label>
                <select className="finp" value={revisionRounds}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRevisionRounds(e.target.value)}>
                  {['1','2','3','4','5'].map(n => <option key={n} value={n}>{n} round{n !== '1' ? 's' : ''}</option>)}
                </select>
              </div>
              <div className="fgrp">
                <label className="flbl">Default payment structure</label>
                <select className="finp" value={paymentStructure}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPaymentStructure(e.target.value)}>
                  <option value="50_50">50% upfront / 50% on delivery</option>
                  <option value="100_upfront">100% upfront</option>
                  <option value="milestones">Milestone-based</option>
                  <option value="monthly">Monthly retainer</option>
                  <option value="on_delivery">100% on delivery</option>
                </select>
              </div>
            </div>
            <div className="fgrp">
              <label className="flbl">Governing law <span className="fhint">— the contract law that governs your SOWs</span></label>
              <input className="finp" value={governingLaw}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGoverningLaw(e.target.value)}
                placeholder="e.g. Republic of Kenya" />
            </div>
            <div className="fgrp">
              <label className="flbl">SOW language <span className="fhint">— the language every generated SOW is drafted in</span></label>
              <select className="finp" value={sowLanguage}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSowLanguage(e.target.value)}>
                {SOW_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(1)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button className="ob-skip" onClick={() => setStep(3)}>Skip</button>
              <button className="btn btn-primary" onClick={submitDefaults} disabled={loading}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3 ──────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <h2 className="ob-title">Invite a team member</h2>
            <p className="ob-sub">Add a colleague to your workspace. You can invite more people any time from the Team page.</p>

            <div className="fgrp">
              <label className="flbl">Email address <span className="fhint">— optional</span></label>
              <input type="email" className="finp" value={inviteEmail} autoFocus
                placeholder="colleague@youragency.com"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value)} />
            </div>
            {inviteRoles.length > 0 && (
              <div className="fgrp">
                <label className="flbl">Role</label>
                <select className="finp" value={inviteRoleId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setInviteRoleId(e.target.value)}>
                  {inviteRoles.map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.is_default ? ' (default)' : ''}</option>
                  ))}
                </select>
                <p className="fhint" style={{ marginTop: 6 }}>Decides what they can see and do. You can change it later on the Team page.</p>
              </div>
            )}
            {error && <div className="auth-error">{error}</div>}

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(2)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button className="ob-skip" onClick={() => { setError(''); setStep(4) }}>Skip for now</button>
              <button className="btn btn-primary" onClick={submitInvite} disabled={loading}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 4 ──────────────────────────────────────── */}
        {step === 4 && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ width: 64, height: 64, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <i className="ti ti-scale" style={{ fontSize: 28, color: 'var(--green)' }} />
            </div>
            <h2 className="ob-title" style={{ textAlign: 'center' }}>Governance is set up</h2>
            <p className="ob-sub" style={{ textAlign: 'center', marginBottom: 28 }}>
              <strong style={{ color: 'var(--text)' }}>Welcome to ScopeGov.</strong> Create your first project,
              generate a Statement of Work, send it to your client — and Guardian
              takes over from there, monitoring every communication for scope drift.
            </p>
            {error && <div className="auth-error">{error}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 280, margin: '0 auto' }}>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '11px' }}
                // FIX: complete() now takes an explicit redirectTo (see its own comment) —
                // `onClick={complete}` would pass the click event itself as that argument,
                // so router.push() ran on a SyntheticEvent instead of '/dashboard'. Wrap it.
                onClick={() => complete()} disabled={loading}>
                {loading ? <span className="spin" /> : <>Go to dashboard <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
              <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}
                disabled={loading}
                onClick={() => {
                  // FIX (round 3, Onboarding Finding 1): previously chained
                  // .then(() => router.push('/projects/new')) unconditionally
                  // — since complete() never surfaced failure, this always
                  // navigated onward even when onboarding was never actually
                  // marked complete, straight back into middleware's
                  // /onboarding redirect. Only navigate on confirmed success —
                  // now handled by complete() itself (see its own comment on
                  // the redirectTo parameter), so this no longer double-pushes.
                  complete('/projects/new')
                }}>
                Create first project
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
