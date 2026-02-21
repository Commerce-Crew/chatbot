<?php declare(strict_types=1);

namespace CommerceCrew\CCChatbot\Storefront\Controller;

use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use Shopware\Storefront\Controller\StorefrontController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route(defaults: ['_routeScope' => ['storefront']])]
class ContextController extends StorefrontController
{
    private const CONFIG_PREFIX = 'CCChatbot.config.';

    public function __construct(
        private readonly SystemConfigService $systemConfigService
    ) {
    }

    #[Route(
        path: '/ccchatbot/context',
        name: 'frontend.ccchatbot.context',
        methods: ['GET', 'POST'],
        defaults: [
            '_httpCache' => false,
            'XmlHttpRequest' => true,
        ]
    )]
    public function context(SalesChannelContext $context, Request $request): JsonResponse
    {
        if (!$this->isChatbotVisible($context)) {
            return new JsonResponse(['success' => false, 'error' => 'forbidden'], Response::HTTP_FORBIDDEN);
        }

        // Return context token for the current session (guest or logged-in).
        // XmlHttpRequest => true allows fetch/XHR to this route (Shopware blocks XHR by default otherwise → 403).
        $payload = [
            'success' => true,
            'context_token' => $context->getToken(),
            'language_id' => $context->getLanguageId(),
        ];

        $response = new JsonResponse($payload);
        $response->headers->set('Cache-Control', 'no-store, no-cache, private, must-revalidate');
        $response->headers->set('Pragma', 'no-cache');

        return $response;
    }

    private function isChatbotVisible(SalesChannelContext $context): bool
    {
        $salesChannelId = $context->getSalesChannelId();
        $enabled = (bool) $this->systemConfigService->get(self::CONFIG_PREFIX . 'enabled', $salesChannelId);
        if (!$enabled) {
            return false;
        }

        $visibilityMode = (string) ($this->systemConfigService->get(self::CONFIG_PREFIX . 'visibilityMode', $salesChannelId) ?? 'everyone');
        $specificCustomerId = trim((string) ($this->systemConfigService->get(self::CONFIG_PREFIX . 'specificCustomerId', $salesChannelId) ?? ''));

        $customer = $context->getCustomer();
        $isLoggedIn = $customer !== null;

        if ($visibilityMode === 'everyone') {
            return true;
        }
        if ($visibilityMode === 'customers_only') {
            return $isLoggedIn;
        }
        if ($visibilityMode === 'specific_customer') {
            return $isLoggedIn && $specificCustomerId !== '' && $customer->getId() === $specificCustomerId;
        }

        return true;
    }
}
