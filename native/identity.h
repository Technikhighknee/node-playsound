/* SPDX-License-Identifier: CC0-1.0 */
#ifndef PS_IDENTITY_H
#define PS_IDENTITY_H
#include <stdint.h>
/* Decode bounded, validated UTF-8 from an ASCII-only startup argument. */
int ps_identity_decode(const char* hex, char name[256]);
/* Main-thread only. Windows retains one session reference until replacement/close. */
int32_t ps_identity_set(const char* name);
void ps_identity_close(void);
#endif
