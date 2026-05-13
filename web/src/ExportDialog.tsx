import React, { useEffect, useState } from 'react'
import { Modal, Segmented, Button, Input, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import { CopyOutlined, DownloadOutlined, ShareAltOutlined } from '@ant-design/icons'
import type { Todo } from './api'

type TurnsMode = 'summary' | 'full' | 'none'

interface Props {
	todo: Todo | null
	open: boolean
	onClose: () => void
}

export default function ExportDialog({ todo, open, onClose }: Props) {
	const { t } = useTranslation(['transcript', 'common'])
	const { message } = useAppMessages()
	const [turns, setTurns] = useState<TurnsMode>('summary')
	const [markdown, setMarkdown] = useState('')
	const [loading, setLoading] = useState(false)

	const larkPromptPrefix = t('transcript:export.larkPromptPrefix')

	useEffect(() => {
		if (!open || !todo) return
		let cancelled = false
		setLoading(true)
		fetch(`/api/todos/${todo.id}/export.md?turns=${turns}`)
			.then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
			.then(text => { if (!cancelled) setMarkdown(text) })
			.catch(e => { if (!cancelled) message.error(t('transcript:export.loadFailed', { msg: e.message })) })
			.finally(() => { if (!cancelled) setLoading(false) })
		return () => { cancelled = true }
	}, [open, todo, turns])

	const copy = async (text: string, hint: string) => {
		try {
			await navigator.clipboard.writeText(text)
			message.success(hint)
		} catch (e: any) {
			message.error(t('transcript:export.copyFailed', { msg: e?.message || t('transcript:export.noClipboard') }))
		}
	}

	const download = () => {
		if (!todo) return
		const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `${todo.title.replace(/[\\/:*?"<>|]/g, '_')}.md`
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}

	return (
		<Modal
			open={open}
			onCancel={onClose}
			title={todo ? t('transcript:export.titleWith', { title: todo.title }) : t('transcript:export.title')}
			width={760}
			footer={null}
			destroyOnClose
		>
			<Space direction="vertical" style={{ width: '100%' }} size="middle">
				<div>
					<Typography.Text type="secondary">{t('transcript:export.sessionContent')}</Typography.Text>
					<div style={{ marginTop: 6 }}>
						<Segmented
							value={turns}
							onChange={(v) => setTurns(v as TurnsMode)}
							options={[
								{ label: t('transcript:export.turnsSummary'), value: 'summary' },
								{ label: t('transcript:export.turnsFull'), value: 'full' },
								{ label: t('transcript:export.turnsNone'), value: 'none' },
							]}
						/>
					</div>
				</div>

				<Input.TextArea
					value={markdown}
					onChange={(e) => setMarkdown(e.target.value)}
					autoSize={{ minRows: 12, maxRows: 24 }}
					style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
					placeholder={loading ? t('transcript:export.generatingPlaceholder') : ''}
				/>

				<Space wrap>
					<Button
						icon={<CopyOutlined />}
						onClick={() => copy(markdown, t('transcript:export.copiedMd'))}
						disabled={loading || !markdown}
					>{t('transcript:export.copyMd')}</Button>
					<Button
						icon={<DownloadOutlined />}
						onClick={download}
						disabled={loading || !markdown}
					>{t('transcript:export.downloadMd')}</Button>
					<Button
						icon={<ShareAltOutlined />}
						onClick={() => copy(larkPromptPrefix + markdown, t('transcript:export.copiedLarkHint'))}
						disabled={loading || !markdown}
						type="primary"
					>{t('transcript:export.pushToLark')}</Button>
				</Space>
				<Typography.Text type="secondary" style={{ fontSize: 12 }}>
					{t('transcript:export.larkFooter')}
				</Typography.Text>
			</Space>
		</Modal>
	)
}
