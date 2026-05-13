import { useCallback, useEffect, useState } from 'react'
import type { FormInstance } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  getWorkDirOptions,
  pickDirectory,
  type WorkDirOption,
} from '../api'

/**
 * WorkDir picker subsystem for the new/edit todo drawer.
 *
 * Owns:
 *   - the cached option list (root + options) loaded when the drawer opens
 *   - the loading flag for that list
 *   - the picker-busy flag for the native directory picker
 *   - the auto-load-on-open effect
 *   - the pick-directory handler that mutates `workDir` on the supplied
 *     antd FormInstance
 *
 * Errors are re-thrown so the caller controls toast UX.
 *
 * @param form    The antd FormInstance backing the new/edit todo drawer.
 *                The hook reads/writes its `workDir` field.
 * @param active  When true the option list auto-refreshes (typically the
 *                drawer-open flag).
 * @param opts.onLoadError  Optional handler invoked when the auto-load
 *                inside the hook's effect fails. Lets callers surface a
 *                toast without owning the effect themselves.
 */
export function useWorkDirPicker(
  form: FormInstance,
  active: boolean,
  opts?: { onLoadError?: (err: unknown) => void },
) {
  const { t } = useTranslation(['todo'])
  const onLoadError = opts?.onLoadError
  const [workDirOptions, setWorkDirOptions] = useState<WorkDirOption[]>([])
  const [workDirRoot, setWorkDirRoot] = useState<string>('')
  const [workDirLoading, setWorkDirLoading] = useState(false)
  const [pickingWorkDir, setPickingWorkDir] = useState(false)

  const fetchWorkDirOptions = useCallback(async () => {
    setWorkDirLoading(true)
    try {
      const result = await getWorkDirOptions()
      setWorkDirRoot(result.root)
      setWorkDirOptions(result.options)
    } finally {
      setWorkDirLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    fetchWorkDirOptions().catch((err) => {
      if (onLoadError) onLoadError(err)
    })
  }, [active, fetchWorkDirOptions, onLoadError])

  /**
   * Open the native directory picker, seeded with the current form value
   * (or the configured root). On confirm, writes back to form.workDir.
   * Re-throws on error so the caller can toast.
   */
  const pickWorkDir = useCallback(async () => {
    setPickingWorkDir(true)
    try {
      const result = await pickDirectory({
        defaultPath: form.getFieldValue('workDir') || workDirRoot,
        prompt: t('todo:workDirPrompt'),
      })
      if (result.cancelled || !result.path) return
      form.setFieldValue('workDir', result.path)
    } finally {
      setPickingWorkDir(false)
    }
  }, [form, workDirRoot, t])

  return {
    workDirOptions,
    workDirRoot,
    workDirLoading,
    pickingWorkDir,
    fetchWorkDirOptions,
    pickWorkDir,
  }
}
