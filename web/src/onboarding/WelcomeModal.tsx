import React from 'react'
import { Modal, Button } from 'antd'
import { EditOutlined, RobotOutlined, CheckCircleOutlined } from '@ant-design/icons'
import './onboarding.css'

interface WelcomeModalProps {
  open: boolean
  onClose: () => void
}

export function WelcomeModal({ open, onClose }: WelcomeModalProps) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={520}
      closable
      maskClosable
      keyboard
      className="welcome-modal"
      rootClassName="welcome-modal-root"
      destroyOnClose
    >
      <div className="welcome-modal__body">
        <h2 className="welcome-modal__title">欢迎使用 AgentQuad</h2>
        <p className="welcome-modal__subtitle">
          四象限里的 AI 调度台 —— 每个待办都能跑一个 Claude/Codex 会话，全本地
        </p>
        <ol className="welcome-modal__steps">
          <li>
            <span className="welcome-modal__step-icon"><EditOutlined /></span>
            <span className="welcome-modal__step-label">新建 todo</span>
            <span className="welcome-modal__step-desc">标题写你想做的事</span>
          </li>
          <li>
            <span className="welcome-modal__step-icon"><RobotOutlined /></span>
            <span className="welcome-modal__step-label">启动 AI 终端</span>
            <span className="welcome-modal__step-desc">在卡片上点 "AI 执行"</span>
          </li>
          <li>
            <span className="welcome-modal__step-icon"><CheckCircleOutlined /></span>
            <span className="welcome-modal__step-label">协作完成</span>
            <span className="welcome-modal__step-desc">关注右上 Rail 提示</span>
          </li>
        </ol>
        <Button
          type="primary"
          size="large"
          onClick={onClose}
          className="welcome-modal__cta"
        >
          开始使用
        </Button>
      </div>
    </Modal>
  )
}

export default WelcomeModal
