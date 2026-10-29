// lib/help/articles/adding-a-client.ts
// Every UI label below was checked against the product code on 2026-10-29; re-check them if a screen is renamed.

import type { HelpArticle } from '../types'

export const addingAClient: HelpArticle = {
  slug: 'adding-a-client',
  title: 'How do I add a client, and what do they get to see?',
  summary: 'Add a client record, fill in the details your documents need, and know exactly what your client receives.',
  category: 'clients-projects',
  order: 1,
  audience: { permissions: ['CREATE_PROJECTS', 'VIEW_CLIENT_DATA'], plan: 'all' },
  shortAnswer:
    'Open **Clients**, click **New client**, and enter a name and an email address. ' +
    'Your client never logs in to ScopeGov: they only receive emails and secure links to the SOWs, change orders and invoices you send. ' +
    'Their name, company, billing address and tax ID are printed on those documents; your internal notes and phone number are never shown to them.',
  beforeYouStart: [
    'The name and email address of the person who will receive and sign your documents.',
    'Optional: the company name, a billing address and a VAT or tax ID, if you want them printed on documents.',
    'Optional: finance or legal addresses that should be copied on everything you send.',
  ],
  steps: [
    {
      title: 'Create the client',
      body: 'Open [Clients](/clients) and click **New client**. Fill in the form and click **Create client**.',
      details: [
        '**Client name** and **Email** are required.',
        '**Company**, **Phone** and **CC on emails** are optional. Separate CC addresses with commas.',
        'You can also add a client while starting a project: click **+ New client** on the **Basics** step. That form only asks for a name and an email, so add the rest later.',
      ],
      watchFor: 'If the email already belongs to a client, you are not blocked into a dead end: the message includes a link to open that client instead.',
    },
    {
      title: 'Add the details your documents print',
      body: 'Open the client and find the **Billing details** card. Click **Add**, fill in the address, and click **Save billing details**.',
      details: [
        '**Address line 1**, **Address line 2**, **City**, **Region / State**, **Postal code** and **Country**.',
        '**VAT / Tax ID** is optional.',
        'Without a billing address, documents still go out, but they omit the “Bill To” address. ScopeGov warns you before sending.',
      ],
    },
    {
      title: 'Check the contact details',
      body: 'On the **Contact details** card, click **Edit** to change the name, company, email, CC list, **Payment terms note** or **Internal notes**, then click **Save contact details**.',
      details: [
        '**Payment terms note** (for example “Net 30, wire only”) is printed on this client’s invoices. Write it for the client.',
        '**Internal notes** are for your team only. They are not shown to the client.',
        '**Timezone** is optional. It decides when an invoice counts as “coming due” for automatic reminders.',
      ],
    },
    {
      title: 'Add more people to copy (optional)',
      body: 'On the **Contacts** card, click **Add**. Enter a **Name**, an optional **Role** and an **Email**, choose **Receives copies of**, then click **Add contact**.',
      details: [
        '**Invoices (billing contact)** gets a copy of every invoice.',
        '**SOWs & change orders (scope contact)** and **SOWs & change orders (approver)** get a copy of every SOW and change order.',
        '**Nothing extra (directory only)** just keeps the person on file.',
        'Tick **Primary contact** to copy that person on every invoice, SOW and change order.',
      ],
      watchFor: 'Contacts are people who get copies of emails. They are not ScopeGov users and cannot sign in.',
    },
  ],
  dos: [
    'Use the email address of the person who actually signs and approves.',
    'Put finance or legal colleagues in **CC on emails**, or add them as a billing or scope contact.',
    'Add the billing address before your first invoice so the “Bill To” block is complete.',
    'Keep private remarks in **Internal notes**, never in **Payment terms note**.',
  ],
  donts: [
    'Do not create a second client for the same company just because you have another contact there. Add a contact instead.',
    'Do not put anything you would not want the client to read in **Payment terms note**: it is printed on invoices.',
    'Do not archive a client expecting its projects to pause. Archiving only hides the client from the default list.',
    'Do not expect clients to sign in: there is no client login.',
  ],
  problems: [
    {
      symptom: 'There is no **New client** button',
      meaning: 'Adding a client needs both the Create Projects and View Client Data permissions. A workspace whose trial or subscription has lapsed is read-only.',
      fix: 'Ask an admin to add the missing permission, or to renew the plan.',
    },
    {
      symptom: 'The message says a client with this email already exists',
      meaning: 'Each email address can belong to only one client in your workspace, whatever its capitalisation.',
      fix: 'Click the link in the message to open the existing client. If it is a different person at the same company, add them as a contact there.',
    },
    {
      symptom: 'A red **bounced** tag, or a banner saying email to this address bounced or was marked as spam',
      meaning: 'The client may not be receiving your documents.',
      fix: 'Check the address with the client and correct it under **Contact details**. Saving a new address clears the warning. Meanwhile, send the signing link yourself with **Copy signing link**.',
    },
    {
      symptom: 'The **Contact** column says **Restricted**',
      meaning: 'Your role does not include View Client Data, so email, phone, contacts and notes are hidden from you.',
      fix: 'Ask an admin for the View Client Data permission.',
    },
    {
      symptom: 'Sending warns that the client has no billing address on file',
      meaning: 'It is a warning, not a blocker. The document will go out without the “Bill To” address.',
      fix: 'Go back, add the address under **Billing details**, then send again. Or choose **Send anyway**.',
    },
    {
      symptom: 'There is no **Delete client** button',
      meaning: 'A client can be deleted only while it has no projects on record, and deleted projects still count. It also needs the Delete Projects permission.',
      fix: 'Use **Archive** to hide the client. To combine duplicates, use **Merge into another client…** under **Manage client record**.',
    },
  ],
  whatHappensNext: [
    'Nothing is sent to the client when you add them. The first thing they receive is the SOW you send.',
    'The client appears in the New project picker and in search, ready to attach to a project.',
    'Archiving hides a client from the default list; **Show archived** brings it back. Starting a new project for an archived client reactivates it. Merging moves all projects to the client you keep and removes the other, and cannot be undone.',
  ],
  related: ['first-project', 'fixed-fee-or-retainer', 'assign-team-members'],
  updated: '2026-10-29',
}
