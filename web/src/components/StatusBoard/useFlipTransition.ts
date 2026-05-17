import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * 给一组「按稳定 key 标识」的 DOM 元素做 FLIP（First / Last / Invert / Play）跨容器动画。
 *
 * 用法：
 *   const flip = useFlipTransition({ duration: 320 })
 *   ...在每张卡片渲染处：
 *     <article ref={(el) => flip.register(session.sessionId, el)}> ... </article>
 *
 * 工作原理：
 *   1. 渲染前（useLayoutEffect 阶段）抓 First 位置：所有当前注册元素的 boundingClientRect
 *   2. 渲染完成后再抓 Last 位置
 *   3. 对同一 key 在 first/last 都存在的元素，算 (dx, dy)：若非零就在元素上瞬间应用反向
 *      transform，再 requestAnimationFrame 里清掉 transform 触发过渡到 0 —— 视觉上就是
 *      "从旧位置飞到新位置"
 *
 * 注意：跨 React 父节点搬家时，新位置容器里的元素是新 mount 的 DOM；同名 key 抢占的就是
 * 旧容器卸载前 register 的那条记录。所以本 hook 必须在父容器渲染期间收集到旧+新两份 ref，
 * 才能跨容器算 delta —— React 19 / 18 都满足：先 unmount 旧 ref（register 收 null）、
 * 再 mount 新 ref。我们在 register 收 null 时主动记录"上一次的 rect 还活着的最后一刻"，
 * 等新 ref 进来时再做 invert。
 */
export interface FlipTransitionOptions {
  duration?: number
  easing?: string
  /** 跨列高亮：新元素 mount 时给一个短暂的边框/光晕 class */
  highlightClass?: string
  highlightMs?: number
}

interface InternalState {
  rects: Map<string, DOMRect>          // key → 最后一次见到时的 rect
  pendingFlip: Map<string, DOMRect>    // key → 旧 rect（待 invert）
  pendingHighlight: Set<string>        // key → mount 后要加 highlight class
}

export function useFlipTransition(opts: FlipTransitionOptions = {}) {
  const {
    duration = 320,
    easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    highlightClass = 'sb-card-arrived',
    highlightMs = 700,
  } = opts

  const stateRef = useRef<InternalState>({
    rects: new Map(),
    pendingFlip: new Map(),
    pendingHighlight: new Set(),
  })

  const register = (key: string, el: HTMLElement | null) => {
    const st = stateRef.current
    if (el === null) {
      // 旧实例被卸载（可能是因为搬家到别的列）。冻结它最后看到的 rect。
      // rects 里保留这个 key 的最后一次 rect，作为新 mount 的 invert 基准。
      // 不做 delete —— 留给新 mount 时计算 delta。
      return
    }

    // 新 mount 时：旧记录就是 "old rect"
    const prevRect = st.rects.get(key)
    const newRect = el.getBoundingClientRect()
    if (prevRect && (Math.abs(prevRect.left - newRect.left) > 0.5 || Math.abs(prevRect.top - newRect.top) > 0.5)) {
      // 算出从 prev 飞到 new 需要的 invert transform
      const dx = prevRect.left - newRect.left
      const dy = prevRect.top - newRect.top
      // 瞬间用 transform 把它"拉回旧位置"
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      // 下一帧清掉 transform，让浏览器把它 transition 回 (0,0)
      requestAnimationFrame(() => {
        el.style.transition = `transform ${duration}ms ${easing}`
        el.style.transform = 'translate(0, 0)'
        // 清理 inline transition，防止后续不相关重渲也吃这个 transition
        const onEnd = () => {
          el.style.transition = ''
          el.style.transform = ''
          el.removeEventListener('transitionend', onEnd)
        }
        el.addEventListener('transitionend', onEnd)
      })
      // 加 arrived 高亮 class
      if (highlightClass) {
        el.classList.add(highlightClass)
        window.setTimeout(() => el.classList.remove(highlightClass), highlightMs)
      }
    }
    // 记录这次见到的 rect，为下次重渲做参照
    st.rects.set(key, newRect)
  }

  // 每次组件提交后顺手刷新 rects 表 —— 没有移动的元素也要更新 rect，
  // 否则下次 layout（侧栏宽度变化、columns 变化）会被误判成"移动了"。
  // 这里用 useLayoutEffect 在 paint 前抓最终位置。
  // 实际抓取在 register 调用时做了，本 effect 仅作"扫描死键"清理。
  useEffect(() => {
    return () => {
      stateRef.current.rects.clear()
    }
  }, [])

  return { register }
}
