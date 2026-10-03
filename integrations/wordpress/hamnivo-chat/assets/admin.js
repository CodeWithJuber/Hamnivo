/**
 * The Test connection button on the settings page. It sends what is typed in the form to the
 * plugin's AJAX handler, and shows the answer. It writes text with textContent only.
 */
(() => {
  const config = window.hamnivoChatAdmin;
  const button = document.getElementById('hamnivo-chat-test');
  const list = document.getElementById('hamnivo-chat-test-results');
  const status = document.getElementById('hamnivo-chat-test-status');
  if (!config || !button || !list || !status || !window.fetch) {
    return;
  }

  const value = (key) => {
    const field = document.getElementById(`hamnivo_chat_${key}`);
    return field ? field.value : '';
  };

  const show = (data) => {
    list.textContent = '';
    for (const check of data.checks) {
      const item = document.createElement('li');
      const mark = document.createElement('strong');
      const detail = document.createElement('span');
      item.className = check.ok ? 'hamnivo-chat-ok' : 'hamnivo-chat-problem';
      mark.textContent = `${check.ok ? config.strings.ok : config.strings.problem}: ${check.label}. `;
      detail.textContent = check.detail;
      item.appendChild(mark);
      item.appendChild(detail);
      list.appendChild(item);
    }
    status.textContent = data.ok ? config.strings.allOk : config.strings.notOk;
  };

  button.addEventListener('click', () => {
    const body = new FormData();
    body.append('action', config.action);
    body.append('nonce', config.nonce);
    for (const key of ['install_code', 'widget_id', 'chat_url', 'api_url']) {
      body.append(key, value(key));
    }

    button.disabled = true;
    list.textContent = '';
    status.textContent = config.strings.testing;
    fetch(config.ajaxUrl, { method: 'POST', credentials: 'same-origin', body })
      .then((response) => response.json())
      .then((payload) => {
        if (!payload?.success) {
          throw new Error('refused');
        }
        show(payload.data);
      })
      .catch(() => {
        status.textContent = config.strings.failed;
      })
      .then(() => {
        button.disabled = false;
      });
  });
})();
