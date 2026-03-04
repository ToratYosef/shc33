import prompts from 'prompts';

export async function askCredentials(action) {
  return prompts([
    {
      type: 'text',
      name: 'username',
      message: `${action} - Username:`,
      validate: (v) => (v?.trim() ? true : 'Username required')
    },
    {
      type: 'password',
      name: 'password',
      message: `${action} - Password:`,
      validate: (v) => (v?.length ? true : 'Password required')
    }
  ]);
}

export async function askSendPayload() {
  return prompts([
    {
      type: 'text',
      name: 'to',
      message: 'Recipient username:',
      validate: (v) => (v?.trim() ? true : 'Recipient required')
    },
    {
      type: 'text',
      name: 'body',
      message: 'Message:',
      validate: (v) => (v?.length ? true : 'Message required')
    }
  ]);
}
