import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const browserMocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { query: browserMocks.query },
    runtime: { sendMessage: browserMocks.sendMessage },
  },
}));

import { App } from '../../src/entrypoints/popup/App';

describe('popup state', () => {
  beforeEach(() => {
    browserMocks.query.mockReset();
    browserMocks.sendMessage.mockReset();
    browserMocks.query.mockResolvedValue([{ id: 17 }]);
  });

  it('renders the tab state returned by the background', async () => {
    browserMocks.sendMessage.mockResolvedValue({ tabId: 17, records: [], status: 'ready' });

    render(<App />);

    expect(await screen.findByText('Статус: ready')).toBeTruthy();
  });

  it('shows an error when the background returns no state', async () => {
    browserMocks.sendMessage.mockResolvedValue(undefined);

    render(<App />);

    expect(await screen.findByText('Не удалось получить состояние вкладки.')).toBeTruthy();
  });
});
