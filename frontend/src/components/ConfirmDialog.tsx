import React from 'react';

interface ConfirmDialogProps {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  message, detail, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, onConfirm, onCancel,
}) => (
  <div
    onClick={onCancel}
    style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '22px 26px', maxWidth: 320, width: '90%',
        boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
      }}
    >
      <p style={{ margin: '0 0 6px', fontSize: '0.88rem', color: 'var(--text)', fontWeight: 600, textAlign: 'center' }}>
        {message}
      </p>
      {detail && (
        <p style={{ margin: '0 0 18px', fontSize: '0.76rem', color: 'var(--muted)', textAlign: 'center' }}>
          {detail}
        </p>
      )}
      {!detail && <div style={{ height: 14 }} />}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1, padding: '7px 12px', borderRadius: 4,
            border: '1px solid var(--border)',
            background: 'var(--surface2)', color: 'var(--muted)',
            cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
          }}
        >{cancelLabel}</button>
        <button
          autoFocus
          onClick={onConfirm}
          style={{
            flex: 1, padding: '7px 12px', borderRadius: 4, border: 'none',
            background: danger ? '#ef5350' : 'var(--accent)',
            color: '#fff', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700,
          }}
        >{confirmLabel}</button>
      </div>
    </div>
  </div>
);

export default ConfirmDialog;
