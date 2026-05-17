import { useCallback, useEffect, useRef } from 'react'

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
  rects: Map<string, DOMRect>            // key → 最后一次见到时的 rect
  containers: Map<string, string>        // key → 上次所在的容器 id（列 id）
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
    containers: new Map(),
  })

  /**
   * 注册一张卡片。需要外部告知"所在容器"（列 id），这样 hook 才能区分：
   *   - 同列内重渲（rect 可能因为内容微调飘几像素）→ 不动画，仅刷新 rect
   *   - 跨列搬家（container 变了）→ FLIP 动画 + 入场高亮
   *
   * `useCallback` 让 register 引用稳定，避免父组件每次重渲都让 React
   * 把 ref 函数当成"新的"导致 detach + reattach 抖动。
   */
  const register = useCallback((key: string, container: string, el: HTMLElement | null) => {
    const st = stateRef.current
    if (el === null) return                 // 卸载：保留 rects/containers 记录给下次 mount

    const prevRect = st.rects.get(key)
    const prevContainer = st.containers.get(key)
    const newRect = el.getBoundingClientRect()
    const containerChanged = prevContainer !== undefined && prevContainer !== container

    if (containerChanged && prevRect) {
      const dx = prevRect.left - newRect.left
      const dy = prevRect.top - newRect.top
      // 跨列搬家才动 —— 同列内时间/token 变化导致的 ±1px 漂移直接忽略
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.style.transition = 'none'
        el.style.transform = `translate(${dx}px, ${dy}px)`
        requestAnimationFrame(() => {
          el.style.transition = `transform ${duration}ms ${easing}`
          el.style.transform = 'translate(0, 0)'
          const onEnd = () => {
            el.style.transition = ''
            el.style.transform = ''
            el.removeEventListener('transitionend', onEnd)
          }
          el.addEventListener('transitionend', onEnd)
        })
        if (highlightClass) {
          el.classList.add(highlightClass)
          window.setTimeout(() => el.classList.remove(highlightClass), highlightMs)
        }
      }
    }

    st.rects.set(key, newRect)
    st.containers.set(key, container)
  }, [duration, easing, highlightClass, highlightMs])

  useEffect(() => {
    return () => {
      stateRef.current.rects.clear()
      stateRef.current.containers.clear()
    }
  }, [])

  return { register }
}
