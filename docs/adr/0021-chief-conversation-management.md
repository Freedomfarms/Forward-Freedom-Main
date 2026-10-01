# ADR-0021: CHIEF conversation management uses three default-off flags

CHIEF can list, read, search, rename, archive, restore, and delete the
authenticated user's interactive conversations. The permissions are three
independent booleans on `chief_conversation_access`. A missing row is off.
Read does not imply organize. Organize does not imply delete.

The flags are not capability-grant rows. A grant row would replace the
empty-grant baseline. They are also not the Module 02 flag and not `web:search`.

The tools use the existing `ChiefSession` checkpoint store. There is no
second transcript store. Reads use the history projection, so ciphertext,
approval payloads, and provider-private fields stay out of the tool result.
Scheduled sessions stay out of list, read, search, and mutation.

Rename, archive, and restore require ToolExecutor confirmation. Delete
requires confirmation and is irreversible. Deleting a parent sets a fork's
parent link to null and keeps the fork. A session waiting on approval cannot
be archived.

The signed-in user's sidebar still lists and opens that user's own chats
without these flags. CHIEF does not treat "this person can open CHIEF" as
permission to read other conversations. There is no pin, folder, project,
Module 01 chat access, or ChatGPT-account conversation tool.
