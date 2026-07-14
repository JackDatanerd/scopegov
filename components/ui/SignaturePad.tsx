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
  const [empty, setEmpty] = useState(true)

  // Size the canvas's internal pixel buffer to match its displayed size at
  // devicePixelRatio, so strokes aren't blurry on retina screens, while
  // keeping the drawing API working in plain CSS-pixel coordinates.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect  = canvas.getBoundingClientRect()
    canvas.width  = rect.width * ratio
    canvas.height = rect.height * ratio
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.scale(ratio, ratio)
      ctx.lineCap  = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 2.2
      ctx.strokeStyle = strokeColour
    }
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
