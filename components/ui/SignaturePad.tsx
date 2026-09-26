// components/ui/SignaturePad.tsx
//
// A minimal, dependency-free draw-to-sign canvas. Mouse and touch both
// work. Draws in the workspace's brand colour by default so it feels
// intentional rather than a random black scribble, but that's just a
// default — signatures don't have to be your brand colour, it's just nicer
// than plain black on first load.
//
// Usage:
//   const padRef = useRef<SignaturePadHandle>(null)
//   <SignaturePad ref={padRef} />
//   const dataUrl = padRef.current?.toDataURL()   // null if nothing drawn
//   padRef.current?.clear()

'use client'
import { useRef, useImperativeHandle, forwardRef, useState, useEffect } from 'react'

export interface SignaturePadHandle {
  clear: () => void
  toDataURL: () => string | null
  isEmpty: () => boolean
}

interface Props {
  strokeColour?: string
  height?: number
  disabled?: boolean
}

const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad(
  { strokeColour = '#1A5C3A', height = 160, disabled = false },
  ref
) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const drawing    = useRef(false)
  const hasInk     = useRef(false)
  const lastPoint  = useRef<{ x: number; y: number } | null>(null)
  // Last CSS-pixel size the buffer was sized for — lets resize() below tell a real box change
  // from a no-op re-observe, and lets it redraw a snapshot back at its original proportions.
  const sizeRef    = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const [empty, setEmpty] = useState(true)

  // FIX (deep audit, client-facing/signing section): the canvas's internal pixel buffer used to be
  // sized ONCE, on mount, from getBoundingClientRect() — but the canvas's CSS size (width:100%) is
  // responsive. A client signing on their phone who rotates the device (or any window/container
  // resize) after the pad has already mounted left the buffer's coordinate space stuck to the old
  // size while getPoint() below keeps computing touch/mouse positions against the NEW, live rect —
  // so a stroke drawn after a resize lands somewhere other than where the pointer actually is,
  // silently corrupting the one thing this whole flow exists to capture correctly. A
  // ResizeObserver keeps the buffer's pixel dimensions in sync with the element's actual box for
  // its whole lifetime, not just at mount, and redraws whatever was already inked (resizing a
  // canvas's width/height attributes clears it) so a mid-signing resize doesn't wipe out a
  // signature the client already drew.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function applyStrokeSettings(ctx: CanvasRenderingContext2D) {
      ctx.lineCap   = 'round'
      ctx.lineJoin  = 'round'
      ctx.lineWidth = 2.2
      ctx.strokeStyle = strokeColour
    }

    function resize() {
      if (!canvas) return
      const ratio = window.devicePixelRatio || 1
      const rect  = canvas.getBoundingClientRect()
      // Hidden or mid-transition (e.g. display:none ancestor) — nothing to size yet.
      if (rect.width === 0 || rect.height === 0) return
      if (rect.width === sizeRef.current.w && rect.height === sizeRef.current.h) return

      const prevW = sizeRef.current.w, prevH = sizeRef.current.h
      const snapshot = hasInk.current ? canvas.toDataURL('image/png') : null

      canvas.width  = rect.width * ratio
      canvas.height = rect.height * ratio
      sizeRef.current = { w: rect.width, h: rect.height }

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(ratio, ratio)
      applyStrokeSettings(ctx)

      if (snapshot && prevW > 0 && prevH > 0) {
        const img = new Image()
        // Redraw at the ORIGINAL css-pixel size, top-left — keeps the client's actual signature
        // proportions instead of stretching it to whatever width the resize left behind.
        img.onload = () => ctx.drawImage(img, 0, 0, prevW, prevH)
        img.src = snapshot
      }
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => observer.disconnect()
    // Deliberately only re-runs on mount/unmount — a colour-only change is handled by the
    // effect below without going through the resize/redraw dance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A stroke-colour change alone (no size change) just needs the context's strokeStyle updated in
  // place — no reason to touch the buffer or existing ink for that.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) ctx.strokeStyle = strokeColour
  }, [strokeColour])

  function getPoint(e: React.MouseEvent | React.TouchEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if ('touches' in e) {
      const t = e.touches[0]
      if (!t) return null
      return { x: t.clientX - rect.left, y: t.clientY - rect.top }
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function start(e: React.MouseEvent | React.TouchEvent) {
    if (disabled) return
    e.preventDefault()
    drawing.current = true
    lastPoint.current = getPoint(e)
  }

  function move(e: React.MouseEvent | React.TouchEvent) {
    if (disabled || !drawing.current) return
    e.preventDefault()
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const pt  = getPoint(e)
    if (!ctx || !pt || !lastPoint.current) return
    ctx.beginPath()
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y)
    ctx.lineTo(pt.x, pt.y)
    ctx.stroke()
    lastPoint.current = pt
    hasInk.current = true
    setEmpty(false)
  }

  function end() {
    drawing.current = false
    lastPoint.current = null
  }

  useImperativeHandle(ref, () => ({
    clear() {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      hasInk.current = false
      setEmpty(true)
    },
    toDataURL() {
      if (!hasInk.current || !canvasRef.current) return null
      return canvasRef.current.toDataURL('image/png')
    },
    isEmpty() { return !hasInk.current },
  }))

  return (
    <div style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height, display: 'block',
          background: disabled ? 'var(--surface-2)' : '#fff',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          cursor: disabled ? 'not-allowed' : 'crosshair', touchAction: 'none',
        }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      {empty && !disabled && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: 'var(--text-3)', pointerEvents: 'none',
        }}>
          Draw your signature here
        </div>
      )}
    </div>
  )
})

export default SignaturePad
