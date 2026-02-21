<?php declare(strict_types=1);

namespace CommerceCrew\CCChatbot\Storefront\Controller;

use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Shopware\Storefront\Controller\StorefrontController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route(defaults: ['_routeScope' => ['storefront']])]
class ContextController extends StorefrontController
{
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
}
