/**
 * Edit-and-resend, browser half.
 *
 * DSH has no "edit a sent user message and regenerate" operation: session
 * history is an append-only event log, so nothing can rewrite an already
 * durable `user/message`. This plugin is the closest honest equivalent:
 *
 *   1. read the completed turn's opening user prompt (text + event seq);
 *   2. `sessions.fork({ atSeq: seq - 1 })` — a child session whose inherited
 *      prefix ends immediately before that prompt;
 *   3. open the child, then submit the edited text as its new prompt.
 *
 * The original session is never touched.
 */
window.__ModuleLoader__.load({
	id: 'dsh-edit-resend',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		const NS = 'edit-resend';
		const STYLE_ID = 'dsh-edit-resend';

		/** Mirrors the shipped chat action-button metrics so the strip stays uniform. */
		const CSS = [
			'.er-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
			'.er-action svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}',
			'.er-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.er-action[data-unavailable]{cursor:default;opacity:.4}',
			'.er-action[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary);background:0 0}',
			'.er-dialog{border-radius:var(--dsw-radius-panel);width:min(560px,100%)}',
			'.er-hint{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}',
			'.er-note{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
			'.er-text{box-sizing:border-box;width:100%;min-height:132px;max-height:320px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;padding:12px 14px;display:block;resize:vertical}',
			'.er-text:focus{border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary);outline:none}',
			'.er-error{margin:10px 0 0;color:var(--dsw-alias-label-error);font-size:12px;line-height:1.6}',
			'.er-footer{display:flex;justify-content:flex-end;gap:8px;width:100%}',
		].join('');

		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const zh = {
			'action.label': '编辑并重发',
			'action.unavailable': '仅可从带用户提示词的已完成轮次编辑重发',
			'dialog.title': '编辑并重发',
			'dialog.hint': '会从这条消息之前分叉出一个新会话，并把下面的内容作为新提示词发送。原会话保持不变。',
			'dialog.note': '原消息含图片或文件附件，附件不会带到新会话。',
			'dialog.submit': '分叉并发送',
			'dialog.sending': '发送中…',
			'dialog.cancel': '取消',
			'error.noPrefix': '这条消息之前没有可继承的历史，无法分叉。',
			'error.noSessions': '会话服务不可用。',
			'error.noConversation': '对话服务不可用，无法发送提示词。',
			'error.fork': '分叉失败：',
			'error.send': '分叉成功，但发送失败：',
			'error.empty': '内容为空，未发送。',
		};
		const en = {
			'action.label': 'Edit and resend',
			'action.unavailable': 'Available only on a completed turn that started from a user prompt',
			'dialog.title': 'Edit and resend',
			'dialog.hint': 'A new session forks from just before this message and the text below is sent as its prompt. The original session is left untouched.',
			'dialog.note': 'The original message carries image or file attachments; they are not copied into the new session.',
			'dialog.submit': 'Fork and send',
			'dialog.sending': 'Sending…',
			'dialog.cancel': 'Cancel',
			'error.noPrefix': 'Nothing precedes this message, so there is no history to fork.',
			'error.noSessions': 'The sessions service is unavailable.',
			'error.noConversation': 'The conversation service is unavailable, so the prompt cannot be sent.',
			'error.fork': 'Fork failed: ',
			'error.send': 'Forked, but sending failed: ',
			'error.empty': 'The text is empty, so nothing was sent.',
		};

		/** Concatenate the text blocks of one message content list. */
		function textOf(content) {
			if (!Array.isArray(content)) return '';
			const parts = [];
			for (const block of content) {
				if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
			}
			return parts.join('');
		}

		/** Count non-text blocks (image/file attachments) of one message content list. */
		function attachmentsOf(content) {
			if (!Array.isArray(content)) return 0;
			let count = 0;
			for (const block of content) {
				if (block !== null && typeof block === 'object' && block.type !== 'text') count += 1;
			}
			return count;
		}

		/** Resolve the turn number owning one finalized assistant message id. */
		function turnOfMessage(snapshot, messageId) {
			const turns = snapshot?.timeline?.turns;
			if (turns === undefined || messageId === undefined) return null;
			for (const [turnNumber, entry] of turns) {
				const tail = entry?.data?.get?.('turn-tail');
				if (tail?.closing?.finalNode?.messageId === messageId) return turnNumber;
			}
			return null;
		}

		/**
		 * Read the opening user prompt of the turn behind one finalized assistant
		 * message: the durable event seq, its text, and its attachment count.
		 */
		function promptOf(snapshot, messageId) {
			const turnNumber = turnOfMessage(snapshot, messageId);
			if (turnNumber === null) return null;
			const keys = snapshot?.locations?.getTurn?.(turnNumber);
			if (keys === undefined) return null;
			for (const key of keys) {
				const node = snapshot.nodes?.get?.(key);
				if (node?.kind !== 'user') continue;
				const content = node.data?.content;
				const seq = node.data?.seq;
				if (typeof seq !== 'number') return null;
				return {
					seq,
					text: textOf(content),
					attachments: attachmentsOf(content),
				};
			}
			return null;
		}

		/** Value equality for {@link promptOf} results, so the selector stays stable. */
		function samePrompt(left, right) {
			if (left === right) return true;
			if (left === null || right === null) return false;
			return left.seq === right.seq && left.text === right.text && left.attachments === right.attachments;
		}

		/** Human-readable message for an unknown throwable. */
		function reasonOf(cause) {
			if (cause !== null && typeof cause === 'object' && typeof cause.message === 'string' && cause.message !== '') return cause.message;
			return String(cause);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'edit-resend: dictionaries');

			/**
			 * One action-strip entry: the button plus its own portaled dialog.
			 * @param props - owner `messageId` and the framework shares.
			 * @returns the action element.
			 */
			function EditResendAction({ messageId, sessionId, useChat, t }) {
				const prompt = useChat((snapshot) => promptOf(snapshot, messageId), samePrompt);
				const [open, setOpen] = React.useState(false);
				const [draft, setDraft] = React.useState('');
				const [busy, setBusy] = React.useState(false);
				const [error, setError] = React.useState(null);

				const available = prompt !== null && prompt.seq > 0;

				const onOpen = React.useCallback(() => {
					setDraft(prompt === null ? '' : prompt.text);
					setError(null);
					setOpen(true);
				}, [prompt]);

				const onClose = React.useCallback(() => {
					if (busy) return;
					setOpen(false);
					setError(null);
				}, [busy]);

				const onSubmit = React.useCallback(() => {
					if (prompt === null) return;
					const text = draft.trim();
					if (text === '') {
						setError(t('error.empty'));
						return;
					}
					const sessions = ctx.get('sessions');
					if (sessions === undefined) {
						setError(t('error.noSessions'));
						return;
					}
					const atSeq = prompt.seq - 1;
					if (atSeq < 0) {
						setError(t('error.noPrefix'));
						return;
					}
					setBusy(true);
					setError(null);
					const run = async () => {
						let childId;
						try {
							childId = await sessions.fork({ sessionId, atSeq, increaseTitle: true });
						} catch (cause) {
							throw new Error(t('error.fork') + reasonOf(cause));
						}
						ctx.get('uiWorkspace')?.openSession?.(childId);
						try {
							await sessions.using(childId, { source: 'edit-resend' }, async (reference) => {
								const binding = reference.binding;
								const conversation = binding?.ctx?.get?.('conversation') ?? ctx.get('conversation');
								if (conversation === undefined) throw new Error(t('error.noConversation'));
								const outcome = await conversation.sendSession(binding.session, text, [], 'queue');
								if (outcome?.kind !== 'success') throw new Error('prompt rejected');
							});
						} catch (cause) {
							throw new Error(t('error.send') + reasonOf(cause));
						}
					};
					run().then(() => {
						setBusy(false);
						setOpen(false);
					}, (cause) => {
						setBusy(false);
						setError(reasonOf(cause));
					});
				}, [ctx, sessionId, prompt, draft, t]);

				const label = available ? t('action.label') : t('action.unavailable');
				const button = React.createElement('button', {
					type: 'button',
					className: 'er-action',
					'aria-label': t('action.label'),
					'aria-disabled': available ? undefined : true,
					'data-unavailable': available ? undefined : true,
					onClick: available ? onOpen : undefined,
					disabled: available ? undefined : true,
				}, React.createElement(primitives.IconEditOutlineRegular, {}));

				const dialog = React.createElement(primitives.Modal, {
					open,
					title: t('dialog.title'),
					closeLabel: t('dialog.cancel'),
					onClose,
					className: 'er-dialog',
					footer: React.createElement('div', { className: 'er-footer' },
						React.createElement(primitives.Button, {
							variant: 'ghost',
							disabled: busy,
							onClick: onClose,
						}, t('dialog.cancel')),
						React.createElement(primitives.Button, {
							variant: 'primary',
							disabled: busy,
							onClick: onSubmit,
						}, busy ? t('dialog.sending') : t('dialog.submit'))),
				}, React.createElement('p', { className: 'er-hint' }, t('dialog.hint')),
					prompt !== null && prompt.attachments > 0
						? React.createElement('p', { className: 'er-note' }, t('dialog.note'))
						: null,
					React.createElement('textarea', {
						className: 'er-text',
						'aria-label': t('dialog.title'),
						value: draft,
						readOnly: busy,
						onChange: (event) => {
							setDraft(event.target.value);
						},
					}),
					error === null ? null : React.createElement('p', { className: 'er-error' }, error));

				return React.createElement(React.Fragment, null,
					React.createElement(primitives.Tooltip, { label, side: 'bottom' }, button),
					dialog);
			}

			ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
				name: 'conversation.chat.assistant-actions',
				id: 'edit-resend',
				order: 20,
				locale: NS,
			}, EditResendAction));
		}

		exports.apply = apply;
		exports.inject = ['slots', 'locale'];
		return module.exports;
	},
});
