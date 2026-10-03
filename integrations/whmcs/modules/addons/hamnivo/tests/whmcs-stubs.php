<?php
/**
 * What WHMCS 8 gives an addon that the tests need and cannot have: the class that says who is
 * signed in. Loaded by the suite at the point it wants it, since a class cannot be taken back.
 */

namespace WHMCS\Authentication {
    class CurrentUser
    {
        /** @var object|null The client the stand-in user is acting for. */
        public static $client = null;

        public function client()
        {
            return self::$client;
        }
    }
}
