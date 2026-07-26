'use strict';

const {
  deepFreeze,
  derivePolicyVersion,
} = require('./merchant-policy-schema');

const policyBody = {
  schemaVersion: 1,
  invariants: {
    automatedRepliesRequireActiveMerchantPolicy: true,
    merchantFactsComeOnlyFromCanonicalPolicy: true,
    probabilisticComponentsHaveNoSendAuthority: true,
    internalMarkersAreSecret: true,
    tenantIsolationRequired: true,
    deliveryAuthorizationFailsClosed: true,
  },
};

const PLATFORM_REPLY_POLICY = deepFreeze({
  ...policyBody,
  policyVersion: derivePolicyVersion(policyBody),
});

module.exports = {
  PLATFORM_REPLY_POLICY,
  platformReplyPolicy: PLATFORM_REPLY_POLICY,
};
