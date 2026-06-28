// Confirmation dialog with an async action + busy state. Built on Modal.
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Modal } from './Modal';
import { Spinner } from './ui';
import { toast } from '../toast';

export function ConfirmDialog({
  open, onClose, title, body, confirmLabel = 'Confirmar', danger, onConfirm, successMsg,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ComponentChildren;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  successMsg?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await onConfirm();
      if (successMsg) toast.success(successMsg);
      onClose();
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo completar la acción');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      footer={
        <>
          <button class="btn btn-ghost" disabled={busy} onClick={onClose}>Cancelar</button>
          <button class={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={run}>
            {busy ? <Spinner /> : null} {confirmLabel}
          </button>
        </>
      }
    >
      <div class="text-[13.5px] text-muted leading-relaxed">{body}</div>
    </Modal>
  );
}
