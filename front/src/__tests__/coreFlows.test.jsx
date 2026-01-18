import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import OnboardClient from '../pages/OnboardClient';
import CreateClientForm from '../components/admin/CreateClientForm';

// Mock the logger utility
vi.mock('../utils/logger', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock sessionStorage
const mockSessionStorage = (() => {
  let store = {};

  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => {
      store[key] = value.toString();
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'sessionStorage', {
  value: mockSessionStorage,
});

// Mock fetch API
global.fetch = vi.fn();

describe('OnboardClient', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    // Reset fetch mock
    global.fetch.mockClear();

    // Reset window.location
    delete window.location;
    window.location = {
      search: '',
      href: 'http://localhost/',
      assign: vi.fn(),
    };
  });

  it('extracts token from URL parameters and displays it in the input field', () => {
    // Mock window.location with token
    Object.defineProperty(window, 'location', {
      value: {
        search: '?token=test-token-123',
        href: 'http://localhost/?token=test-token-123',
        assign: vi.fn(),
      },
      writable: true,
    });

    render(
      <MemoryRouter>
        <OnboardClient />
      </MemoryRouter>
    );

    // Check if the token from URL is displayed in the input field
    const tokenInput = screen.getByRole('textbox', { name: /onboarding token/i });
    expect(tokenInput).toBeInTheDocument();
    expect(tokenInput.value).toBe('test-token-123');
  });

  it('shows loading state when submitting token', async () => {
    // Mock fetch to take some time to simulate loading
    global.fetch.mockImplementationOnce(() =>
      new Promise(resolve =>
        setTimeout(() => resolve({
          ok: true,
          headers: {
            get: () => 'application/json',
          },
          json: async () => ({ url: 'https://stripe.com/connect' }),
        }), 100)  // Delay to allow processing state to be seen
      )
    );

    render(
      <MemoryRouter>
        <OnboardClient />
      </MemoryRouter>
    );

    // Enter a token
    const tokenInput = screen.getByRole('textbox', { name: /onboarding token/i });
    fireEvent.change(tokenInput, { target: { value: 'test-token' } });

    // Click submit button
    const submitButton = screen.getByRole('button', { name: /continue to stripe setup/i });
    fireEvent.click(submitButton);

    // Check for processing text before the promise resolves
    expect(screen.getByText(/verifying token and redirecting\.\.\./i)).toBeInTheDocument();

    // Wait for the button to be disabled
    await waitFor(() => {
      expect(submitButton).toBeDisabled();
    });
  });

  it('shows error message when token is empty', async () => {
    render(
      <MemoryRouter>
        <OnboardClient />
      </MemoryRouter>
    );

    // Click submit button without entering a token
    const submitButton = screen.getByRole('button', { name: /continue to stripe setup/i });
    fireEvent.click(submitButton);

    // Wait for error message to appear
    await waitFor(() => {
      expect(screen.getByText(/please enter your onboarding token/i)).toBeInTheDocument();
    });
  });
});

describe('CreateClientForm', () => {
  const mockOnClientCreated = vi.fn();
  const mockShowToast = vi.fn();

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
    mockOnClientCreated.mockClear();
    mockShowToast.mockClear();

    // Reset fetch mock
    global.fetch.mockClear();
  });

  it('validates required fields and shows error messages', async () => {
    render(
      <CreateClientForm
        onClientCreated={mockOnClientCreated}
        showToast={mockShowToast}
      />
    );

    // Fill in valid values first to enable the button
    const nameInput = screen.getByRole('textbox', { name: /client name/i });
    await userEvent.type(nameInput, 'Test Client');

    const emailInput = screen.getByRole('textbox', { name: /client email/i });
    await userEvent.type(emailInput, 'test@example.com');

    // Wait for button to become enabled
    await waitFor(() => {
      const submitButton = screen.getByRole('button', { name: /create client/i });
      expect(submitButton).not.toBeDisabled();
    });

    // Now clear the name to make it invalid
    await userEvent.clear(nameInput);

    // Wait a moment for state to update, then submit the form
    await new Promise(resolve => setTimeout(resolve, 10));

    // Get the form element and submit it directly
    const form = document.querySelector('form');
    fireEvent.submit(form);

    // Wait for validation error
    await waitFor(() => {
      expect(screen.getByText(/client name is required/i)).toBeInTheDocument();
    });
  });

  it('validates email format', async () => {
    render(
      <CreateClientForm
        onClientCreated={mockOnClientCreated}
        showToast={mockShowToast}
      />
    );

    // Fill in valid values first to enable the button
    const nameInput = screen.getByRole('textbox', { name: /client name/i });
    await userEvent.type(nameInput, 'Test Client');

    const emailInput = screen.getByRole('textbox', { name: /client email/i });
    await userEvent.type(emailInput, 'valid@email.com');

    // Wait for button to become enabled
    await waitFor(() => {
      const submitButton = screen.getByRole('button', { name: /create client/i });
      expect(submitButton).not.toBeDisabled();
    });

    // Now change the email to invalid
    await userEvent.clear(emailInput);
    await userEvent.type(emailInput, 'invalid-email');

    // Wait a moment for state to update, then submit the form
    await new Promise(resolve => setTimeout(resolve, 10));

    // Get the form element and submit it directly
    const form = document.querySelector('form');
    fireEvent.submit(form);

    // Wait for validation error
    await waitFor(() => {
      expect(screen.getByText(/please enter a valid email address/i)).toBeInTheDocument();
    });
  });

  it('successfully creates a client with valid inputs', async () => {
    // Mock successful API response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({
        id: 'client-123',
        name: 'Test Client',
        email: 'test@example.com',
        onboardingToken: 'token-abc-123',
        onboardingUrlHint: 'https://example.com/onboard?token=token-abc-123'
      }),
    });

    // Set admin token in session storage
    sessionStorage.setItem('adminToken', 'admin-token');

    render(
      <CreateClientForm
        onClientCreated={mockOnClientCreated}
        showToast={mockShowToast}
      />
    );

    // Fill in valid form data
    const nameInput = screen.getByRole('textbox', { name: /client name/i });
    fireEvent.change(nameInput, { target: { value: 'Test Client' } });

    const emailInput = screen.getByRole('textbox', { name: /client email/i });
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    // Submit the form
    const submitButton = screen.getByRole('button', { name: /create client/i });
    fireEvent.click(submitButton);

    // Wait for success state
    await waitFor(() => {
      expect(screen.getByText(/client created successfully!/i)).toBeInTheDocument();
    });

    // Check that the API was called correctly
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/accounts'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer admin-token',
        }),
        body: JSON.stringify({
          name: 'Test Client',
          email: 'test@example.com',
        }),
      })
    );

    // Check that callbacks were called
    expect(mockShowToast).toHaveBeenCalledWith('Client Test Client created successfully!', 'success');
    expect(mockOnClientCreated).toHaveBeenCalled();
  });
});