import { SetMetadata } from '@nestjs/common';
import type { ApiKeyScope } from '@erp/contracts';

import { REQUIRED_API_KEY_SCOPE_KEY } from './api-key.guard.js';

/**
 * النطاق الذي يتطلّبه المسار من مفتاح الـAPI.
 *
 * ولا نستعمل `@RequiresPermission` هنا عمداً: رموز الحارس تخصّ **مستخدمين** في جلسة، ومفتاح
 * التكامل قدراتُه نطاقاتٌ اشترى منها ما اشترى. فالديكوريتران يعبّران عن سؤالين مختلفين:
 * «أيملك هذا المستخدم الصلاحية؟» و«أيشمل هذا المفتاح النطاق؟».
 */
export const RequiresApiKeyScope = (scope: ApiKeyScope) => SetMetadata(REQUIRED_API_KEY_SCOPE_KEY, scope);
